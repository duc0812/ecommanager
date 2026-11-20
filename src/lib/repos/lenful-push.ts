import { prisma } from '@/lib/db'
import { DROPSHIP_PUSH_REFUSAL } from '@/lib/dropship'
import { logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { isNonProductLine } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  ACTIVE_STATUSES, CLOSED_PIPELINE, UNKNOWN_RESULT_GRACE_MS, activeKeyFor, checkOrderForPush, closeCancelledPush, collectLineFiles,
  isActive, isUniqueViolation, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow,
} from '@/lib/repos/supplier-push-core'
import {
  LENFUL_UNPAID_LABEL, LenfulError, cancelOrder, createOrder, currentTrackingByItem, designsFor, findOrderByExternalId, findVariant, getOrder, getTrackings,
  getWallet, isCancelled, isLenfulSupplier, listStores, listVariants, mayCarryTracking, methodCodeOf, remoteStatusOf, searchProducts,
  type LenfulCatalogHit, type LenfulLineItem, type LenfulOrder, type LenfulOrderPayload, type LenfulStore,
} from '@/lib/lenful'
import { getLenfulSettings, hasLenfulKey } from '@/lib/lenful-settings'
import { productsWithSuggestions } from '@/lib/repos/suppliers'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview, type PushView } from '@/lib/pgprints-shared'

const NAME = 'Lenful'
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi Lenful đang hiệu lực — không gửi trùng'
const NO_KEY_MESSAGE = 'Chưa lưu API key Lenful ở Setup › Fulfill'
const CANCEL_REASON = 'Cancelled from Ecom Manager'
const TRACKING_WINDOW_DAYS = 90
// States that need a state or province code; Lenful refuses those orders without one.
const STATE_REQUIRED = ['US', 'CA', 'AU']

export async function findLenfulSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isLenfulSupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

async function keyOrThrow(): Promise<string> {
  const settings = await getLenfulSettings()
  if (!settings.apiKey) throw new PushError(NO_KEY_MESSAGE, 400, 'NO_CREDENTIALS')
  return settings.apiKey
}

type ProductRow = { sku: string; apiSku: string | null; apiShipClass: string | null; apiShipCountries: string | null }

/** The Lenful SKU of a tool SKU. Lenful matches it exactly, so there is no fallback to the tool SKU. */
export const lenfulSkuOf = (p: { apiSku?: string | null } | undefined) => p?.apiSku?.trim() || null

export type LenfulEstimate = { goods: number | null; wallet: number | null; note: string }

export type BuiltLenfulPush = { preview: PushPreview & { estimate: LenfulEstimate | null }; rawBody: string | null; externalOrderId: string; supplierId: string | null }

export async function buildLenfulPush(orderId: string): Promise<BuiltLenfulPush | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null

  const settings = await getLenfulSettings()
  const hasKey = hasLenfulKey(settings)
  const supplier = await findLenfulSupplier()
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const own = order.lines.filter(l => !isNonProductLine(l) && !!supplier && l.resolvedSupplierId === supplier.id)
  const plan = planPushLines(order, own.filter(l => !l.dropship), pushes)
  const active = plan.later ? null : pushes.find(p => isActive(p.status)) ?? null
  const externalOrderId = await nextExternalOrderId(orderNo, { orderId, supplierId: supplier?.id ?? null, later: plan.later })
  const pushLines = plan.lines

  if (!hasKey) error('NO_CREDENTIALS', NO_KEY_MESSAGE)
  const { baseUrl, keyOf } = await checkOrderForPush(order, supplier, { name: NAME, active, externalOrderId, lines: pushLines, held: plan.held }, { error, warning })
  for (const l of own) if (l.dropship && !l.exportedAt) warning('DROPSHIP', `${keyOf(l)}: ${DROPSHIP_PUSH_REFUSAL} — dòng này không gửi qua API`, keyOf(l))

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products: ProductRow[] = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({
        where: { supplierId: supplier.id, sku: { in: supplierSkus } },
        select: { sku: true, apiSku: true, apiShipClass: true, apiShipCountries: true },
      })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  // Print positions and prices are Lenful's own, so a send is built from what the catalog says today.
  const catalog = new Map<string, LenfulCatalogHit>()
  let wallet: number | null = null
  if (hasKey && !active) {
    for (const sku of Array.from(new Set(products.map(lenfulSkuOf).filter((s): s is string => !!s)))) {
      try {
        const hit = await findVariant(settings.apiKey!, sku)
        if (hit) catalog.set(sku, hit)
        else error('LF_SKU', `Lenful không có SKU "${sku}" trong catalog — sửa SKU Lenful ở Setup › Fulfill › Lenful › Ghép SKU`)
      } catch (e: any) {
        error('LF_SKU', `Không đọc được SKU "${sku}" từ Lenful: ${e?.message ?? e}`)
      }
    }
    wallet = await getWallet(settings.apiKey!).then(w => w.balance).catch(() => null)
  }

  const countryCode = countryCodeOf(order.shippingCountry)
  const lines: PreviewLine[] = []
  const lineItems: LenfulLineItem[] = []
  const methods = new Set<number | null>()
  let goods: number | null = 0
  let extraAreas = 0

  for (const l of pushLines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const lenfulSku = lenfulSkuOf(product)
    if (!lenfulSku) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa ghép SKU Lenful — vào Setup › Fulfill › Lenful › Ghép SKU`, refId)
    const hit = lenfulSku ? catalog.get(lenfulSku) ?? null : null

    const ownMethod = product?.apiShipClass?.trim() || null
    const wantedMethod = ownMethod ?? settings.shippingMethodCode
    const method = methodCodeOf(wantedMethod)
    if (wantedMethod && method === null) error('SHIP_METHOD', `${refId}: mã cách ship Lenful "${wantedMethod}" không hợp lệ — phải là số trong danh sách Orders › Import của Lenful`, refId)
    methods.add(method)

    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length > 0 && (!countryCode || !shipCountries.includes(countryCode))) {
      error('SHIP_COUNTRY', `${refId}: SKU ${l.resolvedSupplierSku ?? '—'} chỉ giao tới: ${shipCountries.join(', ')} — đơn này giao ${countryCode ?? order.shippingCountry ?? 'không rõ'}`, refId)
    }

    const found = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: NAME }, { error, warning })
    if (!found.image) error('NO_MOCKUP', `${refId}: Lenful bắt buộc gửi kèm ảnh mockup (https) khi gửi file in — dòng này không có`, refId)
    if (l.qty <= 0) error('BAD_QUANTITY', `${refId}: số lượng phải lớn hơn 0`, refId)
    const note = l.designNote?.trim() || null
    if (note) warning('DESIGN_NOTE', `${refId}: có ghi chú sản xuất — ghi chú nội bộ không gửi sang Lenful, báo xưởng riêng nếu cần`, refId)

    let item: LenfulLineItem = { sku: lenfulSku ?? '', quantity: l.qty }
    if (hit) {
      if (hit.product.type === 'dropship') {
        error('LF_DROPSHIP', `${refId}: Lenful ghi SKU ${lenfulSku} là hàng dropship, không nhận file in — kiểm tra lại SKU ghép`, refId)
      } else if (hit.product.positions.length === 0) {
        error('LF_AREA', `${refId}: Lenful không trả về vị trí in nào cho ${hit.product.name ?? lenfulSku}`, refId)
      } else {
        const plan = designsFor(found.prints, hit.product.positions)
        const codes = hit.product.positions.map(p => p.label ? `${p.code} (${p.label})` : p.code).join(', ')
        if (plan.unmatched.length > 0) error('LF_AREA', `${refId}: Lenful không có vị trí in cho file: ${plan.unmatched.join(', ')} — vị trí của sản phẩm: ${codes}`, refId)
        if (plan.missingPrimary) warning('LF_PRIMARY', `${refId}: không có file cho vị trí chính "${plan.missingPrimary}" của Lenful — Lenful có thể từ chối đơn`, refId)
        extraAreas += Math.max(0, plan.designs.length - 1) * l.qty
        item = { ...item, designs: plan.designs, mockup_urls: found.image ? [found.image] : [] }
      }
      goods = goods === null || hit.variant.listPrice === null ? null : goods + hit.variant.listPrice * l.qty
    } else {
      goods = null
    }

    lines.push({
      refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku: lenfulSku, shipClass: method === null ? null : String(method), shipClassSource: ownMethod ? 'product' : 'default',
      shipCountries, templateName: found.templateName, mockupUrl: found.mockupUrl, designNote: note, files: found.files,
    })
    lineItems.push(item)
  }
  if (methods.size > 1) error('SHIP_METHOD_MIXED', `Các dòng của đơn này khác cách ship (${Array.from(methods).map(m => m ?? 'mặc định').join(', ')}) — một đơn Lenful chỉ đi một cách`)

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const name = (order.shippingName ?? order.customerName ?? '').trim()
  const line1 = order.shippingAddress1?.trim() ?? ''
  const line2 = order.shippingAddress2?.trim() || null
  const city = order.shippingCity?.trim() ?? ''
  const postal = order.shippingZip?.trim() || null
  const phone = order.shippingPhone?.trim() || null
  if (!name) error('ADDRESS_NAME', 'Thiếu tên người nhận')
  if (!line1) error('ADDRESS_LINE', 'Thiếu địa chỉ giao hàng (dòng 1)')
  if (!city) error('ADDRESS_CITY', 'Thiếu thành phố giao hàng')
  if (!countryCode) error('ADDRESS_COUNTRY', `Không xác định được mã quốc gia từ "${order.shippingCountry ?? ''}"`)
  if (countryCode && STATE_REQUIRED.includes(countryCode) && !stateCode) error('ADDRESS_STATE', `Thiếu mã bang/tỉnh 2 chữ cho đơn ${countryCode} (bang: "${order.shippingState ?? ''}")`)
  if (!postal) warning('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip)')
  if (!phone) warning('ADDRESS_PHONE', 'Thiếu số điện thoại người nhận')

  let payload: LenfulOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    const method = Array.from(methods)[0] ?? null
    payload = {
      external_order_id: externalOrderId,
      ...(settings.storeId ? { store_id: settings.storeId } : {}),
      ...(method !== null ? { shipping_method_code: method } : {}),
      shipping_address: {
        name, line1, ...(line2 ? { line2 } : {}), city, ...(stateCode ? { state_code: stateCode } : {}),
        ...(postal ? { postal } : {}), country_code: countryCode ?? '', ...(phone ? { phone } : {}),
      },
      line_items: lineItems,
    }
  }
  const rawBody = payload ? JSON.stringify(payload) : null
  const views = await toPushViews(pushes)
  const hasErrors = issues.some(i => i.level === 'error')
  const estimate: LenfulEstimate | null = hasKey && !active && pushLines.length > 0 ? {
    goods,
    wallet,
    note: `Giá phôi theo catalog Lenful, chưa gồm phí ship${extraAreas > 0 ? ` và phí ${extraAreas} vùng in thêm` : ''}. Lenful tự trừ ví khi tạo đơn; ví thiếu thì đơn "Chưa thanh toán" và tự trừ khi nạp tiền.`,
  } : null
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
      pushEnabled: hasKey,
      hasCredentials: hasKey,
      canPush: !!payload && !hasErrors && hasKey,
      payload,
      payloadHash: rawBody ? hashPayload(rawBody) : null,
      lines,
      issues,
      balance: null,
      estimate,
      activePush: views.find(v => isActive(v.status)) ?? null,
      laterSend: plan.later,
      history: views,
    },
  }
}

function landedData(remote: LenfulOrder) {
  return { supplierOrderCode: remote.code ?? remote.id, supplierInternalId: remote.id, remoteStatus: remoteStatusOf(remote), totalCost: remote.total }
}

export async function pushLenfulOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const apiKey = await keyOrThrow()
  const built = await buildLenfulPush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Lenful', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }
  const supplierId = built.supplierId

  const reserved = await reservePush({
    orderId, supplierId, externalOrderId: built.externalOrderId, lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: built.rawBody, userId: input.userId,
  }, DUPLICATE_MESSAGE)

  const holdUnknown = async (text: string) => {
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text } })
    throw new PushError(text, 504, 'UNKNOWN_RESULT')
  }

  let result
  try {
    result = await createOrder(apiKey, built.rawBody)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    // No clear answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
    if (e instanceof LenfulError && e.unknownOutcome) return holdUnknown(`${message}. Chưa rõ Lenful đã nhận đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`)
    // A refused order creates nothing on Lenful (no order, no wallet charge), so the same number can go again.
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: { status: 'FAILED', activeKey: null, error: message, responseJson: e instanceof LenfulError && e.body != null ? JSON.stringify(e.body).slice(0, 20_000) : null },
    })
    throw new PushError(`Lenful từ chối đơn: ${message} — chưa có đơn nào được tạo`, 502, 'CREATE_FAILED')
  }
  if (!result.order) {
    return holdUnknown(result.duplicate
      ? 'Lenful đang xử lý một yêu cầu giống hệt cho mã này — đợi ít phút rồi bấm "Cập nhật trạng thái"'
      : 'Lenful nhận yêu cầu nhưng không trả về mã đơn — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại')
  }

  const remote = result.order
  await prisma.supplierOrderPush.update({
    where: { id: reserved.id },
    data: { status: 'CREATED', error: null, ...landedData(remote), responseJson: JSON.stringify({ duplicate: result.duplicate, order: remote }).slice(0, 200_000) },
  })
  const exported = await markPushExported({ id: reserved.id, orderId, supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
  if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (Lenful) — mã ${remote.code ?? remote.id}${result.duplicate ? ' (Lenful đã có đơn này)' : ''}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

function storeOfRequest(push: PushRow): string | null {
  try { return JSON.parse(push.requestJson)?.store_id ?? null } catch { return null }
}

async function remoteOf(apiKey: string, push: PushRow): Promise<LenfulOrder | null> {
  if (push.supplierInternalId) return getOrder(apiKey, push.supplierInternalId)
  return findOrderByExternalId(apiKey, push.externalOrderId, { since: push.pushedAt, storeId: storeOfRequest(push) })
}

export async function cancelLenfulPush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findLenfulSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Lenful nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const apiKey = await keyOrThrow()
  try {
    const remote = await remoteOf(apiKey, push)
    if (!remote) throw new PushError(`Lenful không có đơn ${push.externalOrderId} — không có gì để huỷ, kiểm tra trên Lenful`, 404, 'NOT_FOUND')
    if (!isCancelled(remote)) {
      const r = await cancelOrder(apiKey, remote.id, CANCEL_REASON)
      const after = r.order ?? (await getOrder(apiKey, remote.id))
      if (r.refused || !after || !isCancelled(after)) {
        const kept = after?.items.filter(i => i.status !== 'cancel').length ?? 0
        if (after) await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { remoteStatus: remoteStatusOf(after), totalCost: after.total, lastSyncedAt: new Date() } })
        throw new PushError(`Lenful không huỷ hết được đơn: ${r.message ?? 'còn dòng đã vào sản xuất'}${kept ? ` (${kept} dòng vẫn còn)` : ''} — đơn vẫn tính là đã gửi`, 409, 'CANCEL_PARTIAL')
      }
    }
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Lenful không huỷ được đơn: ${e?.message ?? e}`, e instanceof LenfulError && e.unknownOutcome ? 504 : 502, 'CANCEL_FAILED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Lenful — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

function parsed(json: string | null): any {
  try { return json ? JSON.parse(json) : null } catch { return null }
}

/**
 * Which Lenful item each of our lines is. The push stores its lines in the order it sent them, and Lenful answers its items in
 * that order; when the SKUs do not line up, an item is still taken when its SKU is the only one of its kind.
 */
export function itemsOfLines(push: Pick<PushRow, 'prevExportJson' | 'requestJson'>, remote: LenfulOrder): Map<string, string> {
  const lineIds: string[] = parsed(push.prevExportJson)?.shopifyLineIds ?? []
  const sent: { sku?: string }[] = parsed(push.requestJson)?.line_items ?? []
  const items = remote.items.filter(i => i.status !== 'cancel')
  const out = new Map<string, string>()
  if (lineIds.length === sent.length && items.length === sent.length && items.every((it, i) => it.sku === sent[i]?.sku)) {
    lineIds.forEach((id, i) => out.set(id, items[i].id))
    return out
  }
  lineIds.forEach((id, i) => {
    const sku = sent[i]?.sku
    const sameSku = items.filter(it => it.sku === sku)
    if (sku && sameSku.length === 1 && sent.filter(s => s.sku === sku).length === 1) out.set(id, sameSku[0].id)
  })
  return out
}

/** Writes each item's current tracking on its line. Returns the note for numbers that could not be placed. */
async function applyTracking(apiKey: string, push: PushRow, remote: LenfulOrder): Promise<{ shipments: number; note: string | null }> {
  const rows = await getTrackings(apiKey, remote.id)
  const current = rows.filter(r => r.current)
  if (current.length === 0) return { shipments: 0, note: null }
  const byItem = currentTrackingByItem(current)
  const itemOf = itemsOfLines(push, remote)
  const numbers = Array.from(new Set(current.map(r => r.number)))
  // One number for the whole order fits every line, even a line whose item cannot be told.
  const single = numbers.length === 1 ? current[0] : null
  let unplaced = 0
  const shipments = await upsertLineTracking(push, line => {
    const itemId = itemOf.get(line.shopifyLineId)
    const t = itemId ? byItem.get(itemId) ?? null : single
    if (!itemId && !single) unplaced++
    return t ? { number: t.number, company: t.carrier } : null
  })
  const note = unplaced > 0 ? `Lenful trả ${numbers.length} mã tracking (${numbers.join(', ')}) mà không ghép được với ${unplaced} dòng — nhập tay đúng dòng` : null
  return { shipments, note }
}

/** One push against Lenful: the order found lands it and brings its status, cost and tracking; none found after the grace time means the send failed. */
async function refreshOne(apiKey: string, push: PushRow): Promise<{ found: boolean; shipments: number }> {
  const now = Date.now()
  const lastSyncedAt = new Date(now)
  const remote = await remoteOf(apiKey, push)
  if (!remote) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: stale
        ? { status: 'FAILED', activeKey: null, lastSyncedAt, error: 'Lenful không có đơn này — lần gửi không thành công, có thể gửi lại' }
        : { lastSyncedAt },
    })
    return { found: false, shipments: 0 }
  }

  const closed = isCancelled(remote)
  const unsettled = push.status === 'SENDING' || push.status === 'FAILED'
  const landed = unsettled && !closed
  const live = push.status === 'CREATED' || landed
  const label = remoteStatusOf(remote)
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: label ?? push.remoteStatus, supplierOrderCode: remote.code ?? push.supplierOrderCode ?? remote.id,
        supplierInternalId: remote.id, totalCost: remote.total ?? push.totalCost,
        ...(landed ? { status: 'CREATED', activeKey: push.activeKey ?? activeKeyFor(push.orderId, push.supplierId) } : {}),
        ...(push.status === 'SENDING' && closed ? { status: 'FAILED', activeKey: null, error: `Lenful đã huỷ đơn này (${label}) — có thể gửi lại` } : {}),
        ...(live ? { error: closed ? `Đơn đang "${label}" bên Lenful — kiểm tra rồi bấm Huỷ để đưa đơn về chờ gửi` : null } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  if (!live || closed || !mayCarryTracking(remote)) return { found: true, shipments: 0 }
  const tracking = await applyTracking(apiKey, push, remote)
  if (tracking.note) await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: tracking.note } })
  return { found: true, shipments: tracking.shipments }
}

export async function refreshLenfulPush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findLenfulSupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi Lenful', 404, 'NOT_FOUND')
  const apiKey = await keyOrThrow()
  try {
    const { found, shipments } = await refreshOne(apiKey, push)
    return { push: await viewOf(push.id), found, shipments }
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Không lấy được trạng thái từ Lenful: ${e?.message ?? e}`, e instanceof LenfulError && e.unknownOutcome ? 504 : 502, 'REFRESH_FAILED')
  }
}

/** Status and tracking of every open Lenful push. Tracking lands on Shipment rows; Auto Fulfill turns those into Shopify fulfillments. */
export async function syncLenfulTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findLenfulSupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Lenful supplier' }
  const settings = await getLenfulSettings()
  if (!settings.apiKey) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Lenful key' }
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES }, pushedAt: { gte: since }, order: { pipelineStatus: { notIn: ['FULFILLED', ...CLOSED_PIPELINE] } } },
  })
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    try {
      const r = await refreshOne(settings.apiKey, push)
      if (r.found) found++
      shipments += r.shipments
    } catch (e: any) {
      console.error('[lenful] tracking sync failed for push', push.id, e?.message ?? e)
    }
  }
  return { pushes: pushes.length, found, shipments }
}

export type LenfulSetupInfo = { skus: { sku: string; lenfulSku: string | null }[]; unpaidOrders: number }

/** What the settings card shows beside the key: the Lenful SKU each tool SKU sends, and the orders still waiting for the wallet. */
export async function lenfulSetupInfo(): Promise<LenfulSetupInfo> {
  const supplier = await findLenfulSupplier()
  if (!supplier) return { skus: [], unpaidOrders: 0 }
  const [products, unpaidOrders] = await Promise.all([
    prisma.supplierProduct.findMany({ where: { supplierId: supplier.id }, select: { sku: true, apiSku: true }, orderBy: { sku: 'asc' } }),
    prisma.supplierOrderPush.count({ where: { supplierId: supplier.id, status: 'CREATED', remoteStatus: { contains: LENFUL_UNPAID_LABEL } } }),
  ])
  return { skus: products.map(p => ({ sku: p.sku, lenfulSku: lenfulSkuOf(p) })), unpaidOrders }
}

export type LenfulConnectionCheck = {
  stores: LenfulStore[]
  wallet: number | null
  problems: string[]
  skus: { lenfulSku: string; product: string | null; type: string | null; listPrice: number | null; positions: string[]; error: string | null }[]
}

/** Reads the stores, the wallet and the Lenful SKUs the tool sends. Creates nothing. */
export async function checkLenfulConnection(): Promise<LenfulConnectionCheck> {
  const apiKey = await keyOrThrow()
  // The stores call proves the key; a refusal there ends the check.
  const stores = await listStores(apiKey)
  const problems: string[] = []
  const wallet = await getWallet(apiKey).then(w => w.balance).catch((e: any) => { problems.push(`Ví: ${e?.message ?? e}`); return null })
  const { skus } = await lenfulSetupInfo()
  const out: LenfulConnectionCheck['skus'] = []
  for (const lenfulSku of Array.from(new Set(skus.map(s => s.lenfulSku).filter((s): s is string => !!s)))) {
    try {
      const hit = await findVariant(apiKey, lenfulSku)
      out.push(hit
        ? { lenfulSku, product: hit.product.name, type: hit.product.type, listPrice: hit.variant.listPrice, positions: hit.product.positions.map(p => p.code), error: null }
        : { lenfulSku, product: null, type: null, listPrice: null, positions: [], error: 'Lenful không có SKU này' })
    } catch (e: any) {
      out.push({ lenfulSku, product: null, type: null, listPrice: null, positions: [], error: e?.message ?? String(e) })
    }
  }
  return { stores, wallet, problems, skus: out }
}

const MAX_QUERIES = 15
const MAX_PRODUCTS = 25

/** Lenful catalog SKUs that may be ours, read by searching the catalog: by `q` when given, else by each tool SKU, its prefix and its product name. */
export async function lenfulSkuCandidates(q?: string | null) {
  const supplier = await findLenfulSupplier()
  if (!supplier) throw new PushError('Chưa có xưởng mã "lenful" trong danh sách xưởng', 404, 'NO_SUPPLIER')
  const apiKey = await keyOrThrow()
  const rows = await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id }, select: { sku: true, productName: true } })
  const queries = q?.trim()
    ? [q.trim()]
    : Array.from(new Set(rows.flatMap(r => [r.sku, r.sku.split('-')[0], r.productName ?? ''].map(s => s.trim()).filter(s => s.length >= 3)))).slice(0, MAX_QUERIES)
  const products = new Map<string, { id: string; name: string | null }>()
  for (const query of queries) {
    if (products.size >= MAX_PRODUCTS) break
    const { products: hits } = await searchProducts(apiKey, query)
    for (const p of hits) if (p.type !== 'dropship' && products.size < MAX_PRODUCTS) products.set(p.id, p)
  }
  const supplierSkus: { skuName: string; skuCode: string | null; productName: string | null }[] = []
  for (const p of Array.from(products.values())) {
    for (const v of await listVariants(apiKey, p.id)) {
      const attrs = Object.values(v.attributes).join(' / ')
      supplierSkus.push({ skuName: v.sku, skuCode: null, productName: [p.name, attrs, v.listPrice !== null ? `$${v.listPrice.toFixed(2)}` : null].filter(Boolean).join(' · ') })
    }
  }
  return { queries, supplierSkus, products: await productsWithSuggestions(supplier.id, supplierSkus) }
}
