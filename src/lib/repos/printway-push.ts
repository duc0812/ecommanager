import { prisma } from '@/lib/db'
import { logHandoffEvent, markPushExported } from '@/lib/repos/push-export'
import { countryCodeOf, countryNameOf, resolveStateCode, splitPersonName } from '@/lib/shipping-address'
import { isLineApproved } from '@/lib/public-artwork'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  ACTIVE_STATUSES, CLOSED_PIPELINE, UNKNOWN_RESULT_GRACE_MS, activeKeyFor, checkOrderForPush, closeCancelledPush, collectLineFiles,
  isActive, isUniqueViolation, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow,
} from '@/lib/repos/supplier-push-core'
import {
  PrintwayError, cancelOrder, createOrder, e164Phone, findOrder, isPrintwaySupplier, payOrder, printwayAreaFor, quoteOrder, trackingForLine,
  type PrintwayOrderItem, type PrintwayOrderPayload, type PrintwayRemoteOrder,
} from '@/lib/printway'
import { getPrintwaySettings } from '@/lib/printway-settings'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview, type PushView } from '@/lib/pgprints-shared'

const NAME = 'Printway'
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi Printway đang hiệu lực — không gửi trùng'
const NO_TOKEN_MESSAGE = 'Chưa lưu token Printway ở Setup › Fulfill'
const TRACKING_WINDOW_DAYS = 90
const UNPAID_NOTE = 'trả tiền trên Printway để đơn vào sản xuất'
// A new order may take a moment to be saved on their side; "not found" on a payment means nothing was charged.
export const PAY_WAIT = { attempts: 4, delayMs: 1000 }

export async function findPrintwaySupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isPrintwaySupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

async function tokenOrThrow(): Promise<string> {
  const { token } = await getPrintwaySettings()
  if (!token) throw new PushError(NO_TOKEN_MESSAGE, 400, 'NO_CREDENTIALS')
  return token
}

export type BuiltPrintwayPush = { preview: PushPreview; rawBody: string | null; externalOrderId: string; supplierId: string | null }

export async function buildPrintwayPush(orderId: string, opts: { quote?: boolean } = {}): Promise<BuiltPrintwayPush | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null

  const { token } = await getPrintwaySettings()
  const supplier = await findPrintwaySupplier()
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const active = pushes.find(p => isActive(p.status)) ?? null
  // A cancelled order keeps its name on their side, so a re-send after a cancel needs a fresh one.
  const cancelled = pushes.filter(p => p.status === 'CANCELLED').length
  const externalOrderId = cancelled > 0 ? `${orderNo}-R${cancelled + 1}` : orderNo

  if (!token) error('NO_CREDENTIALS', NO_TOKEN_MESSAGE)
  const { baseUrl, pushLines, keyOf } = await checkOrderForPush(order, supplier, { name: NAME, active, externalOrderId }, { error, warning })

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: supplierSkus } }, select: { sku: true, apiSku: true, apiShipClass: true, apiShipCountries: true } })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  const countryCode = countryCodeOf(order.shippingCountry)
  const lines: PreviewLine[] = []
  const items: PrintwayOrderItem[] = []
  const services = new Set<string>()

  for (const l of pushLines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const apiSku = product?.apiSku?.trim() || null
    if (!apiSku) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa ghép với SKU của Printway — ghép ở Setup › Fulfill`, refId)

    const service = product?.apiShipClass?.trim() || null
    if (service) services.add(service)

    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length > 0 && (!countryCode || !shipCountries.includes(countryCode))) {
      error('SHIP_COUNTRY', `${refId}: SKU ${apiSku ?? l.resolvedSupplierSku ?? '—'} chỉ giao tới: ${shipCountries.join(', ')} — đơn này giao ${countryCode ?? order.shippingCountry ?? 'không rõ'}`, refId)
    }

    const found = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: NAME }, { error, warning })
    if (!found.image) warning('NO_MOCKUP', `${refId}: không có ảnh mockup (https) để gửi kèm`, refId)
    if (l.qty <= 0) error('BAD_QUANTITY', `${refId}: số lượng phải lớn hơn 0`, refId)
    // The note on a line is the CS team's own; it stays out of what the factory receives.
    const note = l.designNote?.trim() || null
    if (note) warning('DESIGN_NOTE', `${refId}: có ghi chú sản xuất — ghi chú nội bộ không gửi sang Printway, báo xưởng riêng nếu cần`, refId)

    const item: PrintwayOrderItem = { item_sku: apiSku ?? '', quantity: l.qty, ...(found.image ? { mockup_url: found.image } : {}) }
    const parts = found.files.map(f => f.area)
    for (const print of found.prints) {
      const area = printwayAreaFor(print.area, parts)
      if (!area) error('UNKNOWN_SIDE', `${refId}: vùng in "${print.area}" không ứng với mặt nào của Printway — một dòng nhiều mảnh phải đặt tên mảnh theo mặt in`, refId)
      else if (item[area]) error('DUPLICATE_SIDE', `${refId}: hai file cùng in ${area.replace('artwork_', '')}`, refId)
      else item[area] = print.publicUrl ?? ''
    }
    items.push(item)
    lines.push({
      refId, lineId: l.id, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku, shipClass: service, shipClassSource: service ? 'product' : null, shipCountries,
      templateName: found.templateName, mockupUrl: found.mockupUrl, designNote: note, files: found.files,
    })
  }
  if (services.size > 1) error('SHIP_METHOD_MIXED', 'Các dòng Printway của đơn này khác dịch vụ ship — một đơn chỉ đi được một dịch vụ')

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const state = order.shippingState?.trim() || ''
  const name = splitPersonName(order.shippingName ?? order.customerName)
  const phone = e164Phone(order.shippingPhone, countryCode)
  if (!name.first) error('ADDRESS_NAME', 'Thiếu tên người nhận')
  if (!order.shippingAddress1?.trim()) error('ADDRESS_LINE', 'Thiếu địa chỉ giao hàng (address1)')
  if (!order.shippingCity?.trim()) error('ADDRESS_CITY', 'Thiếu thành phố giao hàng')
  if (!countryCode) error('ADDRESS_COUNTRY', `Không xác định được mã quốc gia từ "${order.shippingCountry ?? ''}"`)
  if (!order.shippingZip?.trim()) error('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip)')
  if (!stateCode && !state) error('ADDRESS_STATE', 'Thiếu bang / tỉnh — Printway bắt buộc')
  if (!phone) warning('ADDRESS_PHONE', order.shippingPhone?.trim() ? `Số điện thoại "${order.shippingPhone.trim()}" không đổi được sang dạng quốc tế — đơn đi không có số` : 'Thiếu số điện thoại người nhận')

  let payload: PrintwayOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    const address2 = order.shippingAddress2?.trim()
    const service = Array.from(services)[0]
    payload = {
      order_id: externalOrderId,
      firstName: name.first,
      lastName: name.last,
      ...(phone ? { shipping_phone: phone } : {}),
      shipping_address1: order.shippingAddress1?.trim() ?? '',
      ...(address2 ? { shipping_address2: address2 } : {}),
      shipping_city: order.shippingCity?.trim() ?? '',
      shipping_province: state || (stateCode ?? ''),
      shipping_province_code: stateCode ?? state,
      shipping_zip: order.shippingZip?.trim() ?? '',
      shipping_country: countryCode ? countryNameOf(countryCode) : (order.shippingCountry ?? ''),
      shipping_country_code: countryCode ?? '',
      ...(service ? { shipping_service: service } : {}),
      order_items: items,
    }
  }
  const rawBody = payload ? JSON.stringify(payload) : null

  // Pricing lets Printway judge SKU, address and shipping now, without creating anything.
  if (opts.quote !== false && payload && token && !active && !issues.some(i => i.level === 'error')) {
    try {
      await quoteOrder(token, {
        shipping_country_code: payload.shipping_country_code,
        shipping_province_code: payload.shipping_province_code,
        ...(payload.shipping_service ? { shipping_service: payload.shipping_service } : {}),
        order_items: payload.order_items.map(i => ({ item_sku: i.item_sku, quantity: i.quantity })),
      })
    } catch (e: any) {
      const judged = e instanceof PrintwayError && !e.noResponse && e.status < 500 && e.status !== 429
      if (judged) error('PRINTWAY_REFUSED', `Printway từ chối: ${e.message}`)
      else warning('QUOTE_UNAVAILABLE', `Chưa kiểm tra được với Printway: ${e?.message ?? e}. Vẫn gửi được, Printway sẽ tự kiểm tra lúc nhận đơn`)
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
      pushEnabled: !!token,
      hasCredentials: !!token,
      canPush: !!payload && !hasErrors && !!token,
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

/** Never retried on no answer: the charge may have gone through, and a second one would be real money. */
async function payWhenSaved(token: string, pwOrderId: string): Promise<{ remoteStatus: string; note: string | null }> {
  for (let i = 0; i < PAY_WAIT.attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, PAY_WAIT.delayMs))
    try {
      await payOrder(token, pwOrderId)
      return { remoteStatus: 'paid', note: null }
    } catch (e: any) {
      if (e instanceof PrintwayError && e.noResponse) {
        return { remoteStatus: 'payment unknown', note: `Đã tạo đơn nhưng chưa rõ đã trả tiền hay chưa (${e.message}) — kiểm tra trên Printway trước khi trả lại` }
      }
      const notSavedYet = e instanceof PrintwayError && (e.status === 404 || /not found/i.test(e.message))
      if (!notSavedYet || i === PAY_WAIT.attempts - 1) {
        return { remoteStatus: 'unpaid', note: `Đã tạo đơn nhưng chưa trả tiền: ${e?.message ?? e} — ${UNPAID_NOTE}` }
      }
    }
  }
  return { remoteStatus: 'unpaid', note: `Đã tạo đơn nhưng chưa trả tiền — ${UNPAID_NOTE}` }
}

export async function pushPrintwayOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const token = await tokenOrThrow()
  const built = await buildPrintwayPush(orderId, { quote: false })
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Printway', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }

  const reserved = await reservePush({
    orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId, requestJson: built.rawBody, userId: input.userId,
  }, DUPLICATE_MESSAGE)

  let created: Awaited<ReturnType<typeof createOrder>>
  try {
    created = await createOrder(token, built.rawBody)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    if (e instanceof PrintwayError && (e.noResponse || e.status >= 500)) {
      // No clear answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
      const text = `${message}. Chưa rõ Printway đã nhận đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`
      await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text } })
      throw new PushError(text, 504, 'UNKNOWN_RESULT')
    }
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: {
        status: 'FAILED', activeKey: null, error: message,
        responseJson: e instanceof PrintwayError && e.body != null ? JSON.stringify(e.body).slice(0, 20_000) : null,
      },
    })
    throw new PushError(`Printway từ chối đơn: ${message}`, 502, 'CREATE_FAILED')
  }

  const pwOrderId = created.pwOrderId ?? (await findOrder(token, built.externalOrderId).catch(() => null))?.pwOrderId ?? null
  await prisma.supplierOrderPush.update({
    where: { id: reserved.id },
    data: {
      status: 'CREATED', error: null, supplierOrderCode: pwOrderId, supplierInternalId: pwOrderId, remoteStatus: 'created',
      responseJson: JSON.stringify(created.raw).slice(0, 200_000),
    },
  })
  const exported = await markPushExported({ id: reserved.id, orderId, supplierId: built.supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
  if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (Printway) — mã ${pwOrderId ?? built.externalOrderId}`, input.userId)

  const paid = pwOrderId
    ? await payWhenSaved(token, pwOrderId)
    : { remoteStatus: 'unpaid', note: `Đã tạo đơn nhưng chưa trả tiền: không đọc được mã đơn Printway — ${UNPAID_NOTE}` }
  await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { remoteStatus: paid.remoteStatus, error: paid.note } })
  return { push: await viewOf(reserved.id), exported }
}

export async function cancelPrintwayPush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findPrintwaySupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Printway nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const token = await tokenOrThrow()
  try {
    const pwOrderId = push.supplierOrderCode ?? (await findOrder(token, push.externalOrderId))?.pwOrderId ?? null
    if (!pwOrderId) throw new PushError(`Printway không có đơn ${push.externalOrderId} — không có gì để huỷ, kiểm tra trên Printway`, 404, 'NOT_FOUND')
    await cancelOrder(token, pwOrderId)
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Printway không huỷ được đơn: ${e?.message ?? e}`, e instanceof PrintwayError && e.noResponse ? 504 : 502, 'CANCEL_FAILED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Printway — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

async function applyTracking(push: PushRow, remote: PrintwayRemoteOrder): Promise<number> {
  if (remote.tracking.length === 0) return 0
  const products = await prisma.supplierProduct.findMany({ where: { supplierId: push.supplierId }, select: { sku: true, apiSku: true } })
  const apiSkuOf = new Map(products.map(p => [p.sku, p.apiSku?.trim() || null]))
  return upsertLineTracking(push, line => trackingForLine(line.resolvedSupplierSku ? apiSkuOf.get(line.resolvedSupplierSku) : null, remote.tracking))
}

async function refreshOne(token: string, push: PushRow): Promise<{ found: boolean; shipments: number }> {
  const now = Date.now()
  const lastSyncedAt = new Date(now)
  const remote = await findOrder(token, push.externalOrderId)
  if (!remote) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: stale
        ? { status: 'FAILED', activeKey: null, lastSyncedAt, error: 'Printway không có đơn này — lần gửi không thành công, có thể gửi lại' }
        : { lastSyncedAt },
    })
    return { found: false, shipments: 0 }
  }
  const landed = push.status === 'SENDING' || push.status === 'FAILED'
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remote.status ?? push.remoteStatus,
        supplierOrderCode: push.supplierOrderCode ?? remote.pwOrderId, supplierInternalId: push.supplierInternalId ?? remote.pwOrderId,
        // A send whose answer was lost is never paid from here: the person checks Printway, so one order is never charged twice.
        ...(landed ? { status: 'CREATED', error: `Đơn đã có bên Printway nhưng tool chưa trả tiền — ${UNPAID_NOTE} nếu chưa trả`, activeKey: activeKeyFor(push.orderId, push.supplierId) } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  return { found: true, shipments: push.status === 'CANCELLED' ? 0 : await applyTracking(push, remote) }
}

export async function refreshPrintwayPush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findPrintwaySupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi Printway', 404, 'NOT_FOUND')
  const token = await tokenOrThrow()
  try {
    const { found, shipments } = await refreshOne(token, push)
    return { push: await viewOf(push.id), found, shipments }
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Không lấy được trạng thái từ Printway: ${e?.message ?? e}`, e instanceof PrintwayError && e.noResponse ? 504 : 502, 'REFRESH_FAILED')
  }
}

/** Status and tracking of every open Printway push. Tracking lands on Shipment rows; Auto Fulfill turns those into Shopify fulfillments. */
export async function syncPrintwayTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findPrintwaySupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Printway supplier' }
  const { token } = await getPrintwaySettings()
  if (!token) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Printway token' }
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES }, pushedAt: { gte: since }, order: { pipelineStatus: { notIn: ['FULFILLED', ...CLOSED_PIPELINE] } } },
  })
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    try {
      const r = await refreshOne(token, push)
      if (r.found) found++
      shipments += r.shipments
    } catch (e: any) {
      console.error('[printway] tracking sync failed for push', push.id, e?.message ?? e)
    }
  }
  return { pushes: pushes.length, found, shipments }
}
