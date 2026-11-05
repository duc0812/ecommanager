import { prisma } from '@/lib/db'
import { logHandoffEvent, markPushExported } from '@/lib/repos/push-export'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { isLineApproved } from '@/lib/public-artwork'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  ACTIVE_STATUSES, CLOSED_PIPELINE, UNKNOWN_RESULT_GRACE_MS, activeKeyFor, checkOrderForPush, closeCancelledPush, collectLineFiles,
  isActive, isUniqueViolation, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow,
} from '@/lib/repos/supplier-push-core'
import {
  BondreError, cancelOrder, createOrder, deletePreview, findOrder, findPendingPreview, isBondreSupplier, packageForLine, quoteOrder, shippingTypeOf,
  type BondreOrderItem, type BondreOrderPackage, type BondreOrderPayload, type BondreRemoteOrder, type BondreSession,
} from '@/lib/bondre'
import { bondreSession, getBondreSettings, hasBondreAccount } from '@/lib/bondre-settings'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview, type PushView } from '@/lib/pgprints-shared'

const NAME = 'Bondre'
const MAX_DESIGNS = 4
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi Bondre đang hiệu lực — không gửi trùng'
const NO_ACCOUNT_MESSAGE = 'Chưa lưu tài khoản Bondre ở Setup › Fulfill'
// Tracking stops being worth asking for long before this; the window only keeps a stuck push from being asked about forever.
const TRACKING_WINDOW_DAYS = 90

export async function findBondreSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isBondreSupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

async function sessionOrThrow(): Promise<BondreSession> {
  const settings = await getBondreSettings()
  if (!hasBondreAccount(settings)) throw new PushError(NO_ACCOUNT_MESSAGE, 400, 'NO_CREDENTIALS')
  return bondreSession(settings)
}

/**
 * A number Bondre has seen stays taken: it keeps it on a cancelled order, and on a Preview whose sync failed even after that
 * Preview is cleared. A refusal that made no Preview does not take it, so that retry reuses the number.
 */
function externalOrderIdFor(orderNo: string, pushes: PushRow[]): string {
  const taken = pushes.filter(p => p.status === 'CANCELLED' || (p.status === 'FAILED' && !!p.supplierInternalId)).length
  return taken > 0 ? `${orderNo}-R${taken + 1}` : orderNo
}

export type BuiltBondrePush = { preview: PushPreview; rawBody: string | null; externalOrderId: string; supplierId: string | null }

export async function buildBondrePush(orderId: string, opts: { quote?: boolean } = {}): Promise<BuiltBondrePush | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null

  const settings = await getBondreSettings()
  const hasAccount = hasBondreAccount(settings)
  const supplier = await findBondreSupplier()
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const active = pushes.find(p => isActive(p.status)) ?? null
  const externalOrderId = externalOrderIdFor(orderNo, pushes)

  if (!hasAccount) error('NO_CREDENTIALS', NO_ACCOUNT_MESSAGE)
  const { baseUrl, pushLines, keyOf } = await checkOrderForPush(order, supplier, { name: NAME, active, externalOrderId }, { error, warning })

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: supplierSkus } }, select: { sku: true, apiSku: true, apiShipClass: true, apiShipCountries: true } })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  const countryCode = countryCodeOf(order.shippingCountry)
  const lines: PreviewLine[] = []
  const items: BondreOrderItem[] = []
  const shipTypes = new Set<number>()

  for (const l of pushLines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const apiSku = product?.apiSku?.trim() || null
    if (!apiSku) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa ghép với SKU của Bondre — ghép ở Setup › Fulfill`, refId)

    const shipping = shippingTypeOf(product?.apiShipClass)
    if (!shipping) error('SHIP_METHOD', `${refId}: Bondre không có phương thức ship "${product?.apiShipClass}" — chỉ có Standard, Fast, Express, USPS`, refId)
    else shipTypes.add(shipping.type)

    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length > 0 && (!countryCode || !shipCountries.includes(countryCode))) {
      error('SHIP_COUNTRY', `${refId}: SKU ${apiSku ?? l.resolvedSupplierSku ?? '—'} chỉ giao tới: ${shipCountries.join(', ')} — đơn này giao ${countryCode ?? order.shippingCountry ?? 'không rõ'}`, refId)
    }

    const found = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: NAME }, { error, warning })
    if (found.prints.length > MAX_DESIGNS) error('TOO_MANY_PARTS', `${refId}: có ${found.prints.length} file in, Bondre nhận tối đa ${MAX_DESIGNS} file một dòng`, refId)
    if (!found.image) error('NO_MOCKUP', `${refId}: Bondre bắt buộc có ảnh mockup (https) — dòng này không có`, refId)
    if (l.qty <= 0 || l.qty > 1000) error('BAD_QUANTITY', `${refId}: số lượng phải từ 1 đến 1000`, refId)
    // The note on a line is the CS team's own; it stays out of what the factory receives.
    const note = l.designNote?.trim() || null
    if (note) warning('DESIGN_NOTE', `${refId}: có ghi chú sản xuất — ghi chú nội bộ không gửi sang Bondre, báo xưởng riêng nếu cần`, refId)

    lines.push({
      refId, lineId: l.id, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku, shipClass: shipping?.name ?? null, shipClassSource: product?.apiShipClass?.trim() ? 'product' : 'default', shipCountries,
      templateName: found.templateName, mockupUrl: found.mockupUrl, designNote: note, files: found.files,
    })
    const designs = Object.fromEntries(found.prints.slice(0, MAX_DESIGNS).map((p, i) => [`design${i + 1}`, p.publicUrl ?? '']))
    items.push({ skuName: apiSku ?? '', quantity: l.qty, design1: '', ...designs, mockup1: found.image ?? '' })
  }
  if (shipTypes.size > 1) error('SHIP_METHOD_MIXED', 'Các dòng Bondre của đơn này khác phương thức ship — một kiện chỉ đi được một phương thức')

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const recipientName = (order.shippingName ?? order.customerName ?? '').trim()
  const phone = (order.shippingPhone ?? '').trim()
  const streetAddress = [order.shippingAddress1, order.shippingAddress2].map(s => s?.trim()).filter(Boolean).join(', ')
  if (!recipientName) error('ADDRESS_NAME', 'Thiếu tên người nhận')
  if (!streetAddress) error('ADDRESS_LINE', 'Thiếu địa chỉ giao hàng')
  if (!order.shippingCity?.trim()) error('ADDRESS_CITY', 'Thiếu thành phố giao hàng')
  if (!countryCode) error('ADDRESS_COUNTRY', `Không xác định được mã quốc gia từ "${order.shippingCountry ?? ''}"`)
  if (!order.shippingZip?.trim()) error('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip) — Bondre bắt buộc')
  if (!stateCode && countryCode === 'US') error('ADDRESS_STATE', `Thiếu mã bang 2 chữ cho đơn Mỹ (bang: "${order.shippingState ?? ''}")`)
  if (!phone) warning('ADDRESS_PHONE', 'Thiếu số điện thoại người nhận')

  let payload: BondreOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    const state = stateCode ?? order.shippingState?.trim()
    const pack: BondreOrderPackage = {
      recipientName,
      ...(phone ? { phoneNumber: phone } : {}),
      streetAddress,
      city: order.shippingCity?.trim() ?? '',
      ...(state ? { stateCode: state } : {}),
      postcode: order.shippingZip?.trim() ?? '',
      countryCode: countryCode ?? '',
      expressShippingType: Array.from(shipTypes)[0] ?? 1,
      items,
    }
    payload = { merchantOrderCode: externalOrderId, orderType: 'Official Order', autoSync: true, packages: [pack] }
  }
  const rawBody = payload ? JSON.stringify(payload) : null

  // The quote lets Bondre judge SKU, address and shipping now, without creating or reserving anything.
  if (opts.quote !== false && rawBody && hasAccount && !active && !issues.some(i => i.level === 'error')) {
    try {
      const quote = await quoteOrder(bondreSession(settings), rawBody)
      for (const m of quote.errors) error('BONDRE_REFUSED', `Bondre từ chối: ${m}`)
      for (const m of quote.warnings) warning('BONDRE_WARNING', m)
    } catch (e: any) {
      const judged = e instanceof BondreError && !e.noResponse && e.status < 500 && e.status !== 429
      if (judged) error('BONDRE_REFUSED', `Bondre từ chối: ${e.message}`)
      else warning('QUOTE_UNAVAILABLE', `Chưa kiểm tra được với Bondre: ${e?.message ?? e}. Vẫn gửi được, Bondre sẽ tự kiểm tra lúc nhận đơn`)
    }
  }

  const views = await toPushViews(pushes)
  const hasErrors = issues.some(i => i.level === 'error')
  return {
    rawBody,
    externalOrderId,
    supplierId: supplier?.id ?? null,
    preview: {
      order: {
        id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus,
        storeName: order.store.project?.name ?? order.store.shop,
      },
      supplier,
      pushEnabled: hasAccount,
      hasCredentials: hasAccount,
      canPush: !!payload && !hasErrors && hasAccount,
      payload,
      payloadHash: rawBody ? hashPayload(rawBody) : null,
      lines,
      issues,
      balance: null,
      activePush: views.find(v => isActive(v.status)) ?? null,
      history: views,
    },
  }
}

/** A Preview left on Bondre by a failed sync would sit one "ALL Sync" click away from becoming an order. */
async function clearPreview(session: BondreSession, previewId: number): Promise<string | null> {
  try {
    await deletePreview(session, previewId)
    return null
  } catch (e: any) {
    return `Chưa xoá được Preview ${previewId} bên Bondre (${e?.message ?? e}) — đừng bấm Sync All trên Bondre, xoá Preview này tay`
  }
}

export async function pushBondreOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const session = await sessionOrThrow()
  const built = await buildBondrePush(orderId, { quote: false })
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Bondre', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }

  const reserved = await reservePush({
    orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId, requestJson: built.rawBody, userId: input.userId,
  }, DUPLICATE_MESSAGE)

  const unknownResult = async (message: string, previewId: number | null): Promise<never> => {
    // No clear answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
    const text = `${message}. Chưa rõ Bondre đã tạo đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text, ...(previewId ? { supplierInternalId: String(previewId) } : {}) } })
    throw new PushError(text, 504, 'UNKNOWN_RESULT')
  }

  let created: Awaited<ReturnType<typeof createOrder>>
  try {
    created = await createOrder(session, built.rawBody)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    if (e instanceof BondreError && (e.noResponse || e.status >= 500)) return unknownResult(message, null)
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: {
        status: 'FAILED', activeKey: null, error: message,
        responseJson: e instanceof BondreError && e.body != null ? JSON.stringify(e.body).slice(0, 20_000) : null,
      },
    })
    throw new PushError(`Bondre từ chối đơn: ${message}`, 502, 'CREATE_FAILED')
  }

  if (created.syncStatus === 'UNKNOWN') return unknownResult('Bondre không xác nhận được kết quả', created.previewId)

  if (created.syncStatus !== 'SYNCED') {
    const reason = created.syncError ?? 'Bondre không chuyển Preview thành đơn'
    const leftover = created.previewId ? await clearPreview(session, created.previewId) : null
    const message = leftover ? `${reason}. ${leftover}` : reason
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: {
        status: 'FAILED', activeKey: null, error: message, supplierInternalId: created.previewId ? String(created.previewId) : null,
        responseJson: JSON.stringify(created.raw).slice(0, 20_000),
      },
    })
    throw new PushError(`Bondre từ chối đơn: ${message}`, 502, 'CREATE_FAILED')
  }

  await prisma.supplierOrderPush.update({
    where: { id: reserved.id },
    data: {
      status: 'CREATED', error: null, supplierInternalId: created.previewId ? String(created.previewId) : null,
      supplierOrderCode: created.orderCode ?? created.orderCodes[0] ?? null, remoteStatus: 'synced',
      responseJson: JSON.stringify(created.raw).slice(0, 200_000),
    },
  })
  const exported = await markPushExported({ id: reserved.id, orderId, supplierId: built.supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
  if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (Bondre) — mã ${created.orderCode ?? built.externalOrderId}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

export async function cancelBondrePush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findBondreSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Bondre nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const session = await sessionOrThrow()
  try {
    const remote = await findOrder(session, push.externalOrderId)
    if (!remote) throw new PushError(`Bondre không có đơn ${push.externalOrderId} — không có gì để huỷ, kiểm tra trên Bondre`, 404, 'NOT_FOUND')
    const ids = remote.memberOrderIds.length > 0 ? remote.memberOrderIds : [remote.orderId]
    for (const id of ids) await cancelOrder(session, id, `cancel-${push.id}-${id}`)
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Bondre không huỷ được đơn: ${e?.message ?? e}`, e instanceof BondreError && e.noResponse ? 504 : 502, 'CANCEL_FAILED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Bondre — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

async function applyTracking(push: PushRow, remote: BondreRemoteOrder): Promise<number> {
  const tracked = remote.packages.filter(p => !!p.tracking)
  if (tracked.length === 0) return 0
  const products = await prisma.supplierProduct.findMany({ where: { supplierId: push.supplierId }, select: { sku: true, apiSku: true } })
  const apiSkuOf = new Map(products.map(p => [p.sku, p.apiSku?.trim() || null]))
  return upsertLineTracking(push, line => {
    const pack = packageForLine(line.resolvedSupplierSku ? apiSkuOf.get(line.resolvedSupplierSku) : null, remote.packages)
    return pack?.tracking ? { number: pack.tracking, company: null } : null
  })
}

/** One push against Bondre: a formal order lands it and brings its tracking; a lone Preview after the grace time means the send failed. */
async function refreshOne(session: BondreSession, push: PushRow): Promise<{ found: boolean; shipments: number }> {
  const now = Date.now()
  const lastSyncedAt = new Date(now)
  const remote = await findOrder(session, push.externalOrderId)
  if (!remote) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    if (!stale) {
      await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { lastSyncedAt } })
      return { found: false, shipments: 0 }
    }
    const preview = await findPendingPreview(session, push.externalOrderId)
    const leftover = preview ? await clearPreview(session, preview.previewId) : null
    const reason = preview
      ? `Bondre chưa tạo đơn${preview.syncError ? `: ${preview.syncError}` : ''}`
      : 'Bondre không có đơn này — lần gửi không thành công, có thể gửi lại'
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        status: 'FAILED', activeKey: null, lastSyncedAt, error: leftover ? `${reason}. ${leftover}` : reason,
        supplierInternalId: preview ? String(preview.previewId) : null,
      },
    })
    return { found: false, shipments: 0 }
  }
  const landed = push.status === 'SENDING' || push.status === 'FAILED'
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remote.status ?? push.remoteStatus,
        supplierOrderCode: push.supplierOrderCode ?? remote.orderCode,
        ...(landed ? { status: 'CREATED', error: null, activeKey: activeKeyFor(push.orderId, push.supplierId) } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  return { found: true, shipments: push.status === 'CANCELLED' ? 0 : await applyTracking(push, remote) }
}

export async function refreshBondrePush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findBondreSupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi Bondre', 404, 'NOT_FOUND')
  const session = await sessionOrThrow()
  try {
    const { found, shipments } = await refreshOne(session, push)
    return { push: await viewOf(push.id), found, shipments }
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Không lấy được trạng thái từ Bondre: ${e?.message ?? e}`, e instanceof BondreError && e.noResponse ? 504 : 502, 'REFRESH_FAILED')
  }
}

/** Status and tracking of every open Bondre push. Tracking lands on Shipment rows; Auto Fulfill turns those into Shopify fulfillments. */
export async function syncBondreTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findBondreSupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Bondre supplier' }
  const settings = await getBondreSettings()
  if (!hasBondreAccount(settings)) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Bondre account' }
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES }, pushedAt: { gte: since }, order: { pipelineStatus: { notIn: ['FULFILLED', ...CLOSED_PIPELINE] } } },
  })
  const session = bondreSession(settings)
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    try {
      const r = await refreshOne(session, push)
      if (r.found) found++
      shipments += r.shipments
    } catch (e: any) {
      console.error('[bondre] tracking sync failed for push', push.id, e?.message ?? e)
    }
  }
  return { pushes: pushes.length, found, shipments }
}
