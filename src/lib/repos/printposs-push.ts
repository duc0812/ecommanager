import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { countryCodeOf, resolveStateCode, splitPersonName } from '@/lib/shipping-address'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import { logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { checkOrderForPush, collectLineFiles, isActive, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow } from '@/lib/repos/supplier-push-core'
import { getPrintpossSettings } from '@/lib/printposs-settings'
import { isPrintpossSupplier, printpossId } from '@/lib/printposs-shared'
import { createPrintpossOrder, findPrintpossOrder, getPrintpossOrder, listPrintpossStores, listPrintpossVariants, PrintpossError, printpossRemoteStatus, printpossTrackingFor, type PrintpossItem, type PrintpossOrder, type PrintpossPayload } from '@/lib/printposs'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview } from '@/lib/pgprints-shared'
import { upsertProductMapping } from '@/lib/repos/suppliers'

const DUPLICATE = 'Đơn đã có lần gửi Printposs đang hiệu lực — không gửi trùng'

export async function findPrintpossSupplier() {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  return all.find(s => s.isActive && isPrintpossSupplier(s)) ?? null
}

async function tokenOrThrow() {
  const settings = await getPrintpossSettings()
  if (!settings.token) throw new PushError('Chưa lưu API token Printposs ở Setup › Fulfill', 400, 'NO_CREDENTIALS')
  return settings.token
}

export async function syncPrintpossCatalog() {
  const variants = await listPrintpossVariants(await tokenOrThrow())
  const active = variants.filter(v => v.active)
  const skus = new Set<string>()
  for (const v of active) {
    if (skus.has(v.sku) || v.baseCost === null || v.baseCost < 0) throw new PushError(`Catalog Printposs có SKU trùng hoặc giá không hợp lệ: ${v.sku}`, 502, 'BAD_CATALOG')
    skus.add(v.sku)
  }
  const supplier = await findPrintpossSupplier() ?? await prisma.supplier.upsert({
    where: { code: 'printposs' }, create: { name: 'Printposs', code: 'printposs', apiType: 'printposs' },
    update: { isActive: true, apiType: 'printposs' },
  })
  let imported = 0
  for (const v of active) {
    await upsertProductMapping({ supplierId: supplier.id, sku: v.sku, apiSku: String(v.id), baseCost: v.baseCost!,
      productName: [v.productName, v.name].filter(Boolean).join(' · '), requiresDesign: true, currency: 'USD' })
    imported++
  }
  return { supplierId: supplier.id, imported, inactive: variants.length - active.length }
}

export async function checkPrintpossConnection() {
  const token = await tokenOrThrow()
  const [stores, variants] = await Promise.all([listPrintpossStores(token), listPrintpossVariants(token)])
  return { stores, activeVariants: variants.filter(v => v.active).length }
}

export async function buildPrintpossPush(orderId: string): Promise<{ preview: PushPreview; rawBody: string | null; externalOrderId: string; supplierId: string | null } | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null
  const [settings, supplier] = await Promise.all([getPrintpossSettings(), findPrintpossSupplier()])
  const pushes = supplier ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } }) : []
  const own = order.lines.filter(l => !isNonProductLine(l) && l.resolvedSupplierId === supplier?.id)
  const plan = planPushLines(order, own.filter(l => !l.dropship), pushes)
  const active = plan.later ? null : pushes.find(p => isActive(p.status)) ?? null
  const externalOrderId = await nextExternalOrderId(order.shopifyOrderNumber.replace(/^#/, ''), { orderId, supplierId: supplier?.id ?? null, later: plan.later })
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }
  const { baseUrl, keyOf } = await checkOrderForPush(order, supplier, { name: 'Printposs', active, externalOrderId, lines: plan.lines, held: plan.held }, { error, warning })
  if (!settings.token) error('NO_CREDENTIALS', 'Chưa lưu API token Printposs ở Setup › Fulfill')
  if (!plan.lines.length && !active) error('NO_LINES', 'Không có dòng Printposs đã duyệt và chưa gửi')
  for (const l of own.filter(l => l.dropship && !l.exportedAt)) warning('DROPSHIP', `${keyOf(l)}: hàng dropship không gửi file in qua API`)
  const skus = plan.lines.flatMap(l => l.resolvedSupplierSku ? [l.resolvedSupplierSku] : [])
  const products = supplier ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: skus } } }) : []
  let variants: Awaited<ReturnType<typeof listPrintpossVariants>> = []
  if (settings.token && !active && plan.lines.length) {
    try {
      variants = await listPrintpossVariants(settings.token)
      if (settings.storeId && !(await listPrintpossStores(settings.token)).some(s => s.id === printpossId(settings.storeId))) error('STORE', 'Store ID không thuộc tài khoản Printposs hiện tại')
    } catch (e: any) { error('CATALOG', `Không xác minh được catalog/store Printposs: ${e.message}`) }
  }
  const items: PrintpossItem[] = []
  const lines: PreviewLine[] = []
  const country = countryCodeOf(order.shippingCountry)
  for (const l of plan.lines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt`, refId)
    const product = products.find(p => p.sku === l.resolvedSupplierSku)
    const variantId = printpossId(product?.apiSku)
    const variant = variants.find(v => v.id === variantId)
    if (!variantId) error('NO_API_SKU', `${refId}: thiếu Product Variant ID Printposs — đồng bộ catalog hoặc sửa SKU API ở trang xưởng`, refId)
    else if (!variant?.active && !active) error('VARIANT_INACTIVE', `${refId}: biến thể ${variantId} không tồn tại hoặc đã ngừng bán ở Printposs`, refId)
    const countries = parseShipCountries(product?.apiShipCountries)
    if (countries.length && (!country || !countries.includes(country))) error('SHIP_COUNTRY', `${refId}: SKU chỉ giao tới ${countries.join(', ')}`, refId)
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) error('QUANTITY', `${refId}: số lượng phải là số nguyên dương`, refId)
    const found = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: 'Printposs' }, { error, warning })
    if (found.prints.length !== 1 || !found.prints[0]?.publicUrl) error('SINGLE_DESIGN', `${refId}: Printposs chỉ nhận một ảnh thiết kế mỗi item — cần một file in hoàn chỉnh`, refId)
    if (!found.image) error('NO_MOCKUP', `${refId}: Printposs bắt buộc có ảnh mockup HTTPS`, refId)
    if (l.designNote?.trim()) warning('DESIGN_NOTE', `${refId}: ghi chú nội bộ không gửi sang Printposs — báo xưởng riêng nếu cần`, refId)
    for (const f of found.files) if (f.sizeOk === false && order.artworks.find(a => a.id === f.artworkId)?.source === 'AUTO') error('SIZE_MISMATCH_AUTO', `${refId}: file AUTO sai khổ template — render lại trước khi gửi`, refId)
    items.push({ product_variant_id: variantId ?? 0, quantity: l.qty, design_image_url: found.prints[0]?.publicUrl ?? '', mockup_image_url: found.image ?? '' })
    lines.push({ refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle,
      quantity: l.qty, supplierSku: l.resolvedSupplierSku, apiSku: variantId ? String(variantId) : null, shipClass: null, shipClassSource: null,
      shipCountries: countries, templateName: found.templateName, mockupUrl: found.mockupUrl, designNote: l.designNote, files: found.files })
  }
  const name = splitPersonName((order.shippingName ?? order.customerName ?? '').trim())
  const region = resolveStateCode({ countryCode: country, stateCode: order.shippingStateCode, state: order.shippingState }) ?? order.shippingState?.trim() ?? ''
  const payload: PrintpossPayload = {
    external_order_id: externalOrderId, first_name: name.first, last_name: name.last, address_1: order.shippingAddress1?.trim() ?? '',
    address_2: order.shippingAddress2?.trim() || undefined, city: order.shippingCity?.trim() ?? '', region, zip: order.shippingZip?.trim() ?? '', country: country ?? '',
    email: order.customerEmail?.trim() || undefined, phone: order.shippingPhone?.trim() || undefined,
    store_id: printpossId(settings.storeId) ?? undefined, is_sample: false, is_fba: false, items,
  }
  for (const field of ['first_name', 'last_name', 'address_1', 'city', 'region', 'zip', 'country'] as const) {
    if (!payload[field]) error('ADDRESS', `Thiếu thông tin giao hàng Printposs: ${field}`)
  }
  const rawBody = items.length ? JSON.stringify(payload) : null
  const history = await toPushViews(pushes)
  return { rawBody, externalOrderId, supplierId: supplier?.id ?? null, preview: {
    order: { id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus, storeName: order.store.project?.name ?? order.store.shop },
    supplier, pushEnabled: !!settings.token, hasCredentials: !!settings.token, canPush: !!rawBody && !issues.some(i => i.level === 'error'),
    payload: items.length ? payload : null, payloadHash: rawBody ? hashPayload(rawBody) : null, lines, issues, balance: null,
    activePush: history.find(p => isActive(p.status)) ?? null, laterSend: plan.later, history,
  } }
}

function landed(remote: PrintpossOrder) {
  return { supplierOrderCode: remote.order_number, supplierInternalId: remote.order_number, remoteStatus: printpossRemoteStatus(remote), totalCost: remote.total_cost }
}

export async function pushPrintpossOrder(orderId: string, input: { payloadHash: string; userId: string | null }) {
  const token = await tokenOrThrow()
  const built = await buildPrintpossPush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length || !built.rawBody || !built.supplierId) throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Printposs', 422, 'NOT_ELIGIBLE', errors)
  if (input.payloadHash !== built.preview.payloadHash) throw new PushError('Nội dung đơn đã thay đổi — mở lại bản xem trước', 409, 'PAYLOAD_CHANGED')
  const reserved = await reservePush({ orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId,
    lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: built.rawBody, userId: input.userId }, DUPLICATE)
  let remote: PrintpossOrder
  try {
    remote = await createPrintpossOrder(token, built.rawBody)
    if (remote.external_order_id !== built.externalOrderId) throw new PrintpossError('Printposs trả mã ngoài không khớp yêu cầu', 502, true)
  } catch (e: any) {
    const unknown = !(e instanceof PrintpossError) || e.unknownOutcome
    const message = unknown ? `${e.message}. Chưa rõ Printposs đã nhận đơn; cập nhật trạng thái để đối chiếu, không gửi lại` : e.message
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: {
      error: message, ...(!unknown ? { status: 'FAILED', activeKey: null } : {}),
    } })
    throw new PushError(message, unknown ? 504 : 502, unknown ? 'UNKNOWN_RESULT' : 'CREATE_FAILED')
  }
  await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { status: 'CREATED', error: null, ...landed(remote), responseJson: JSON.stringify(remote) } })
  const exported = await markPushExported({ ...reserved, orderId, supplierId: built.supplierId, pushedById: input.userId })
  await logHandoffEvent(orderId, `Chuyển supplier qua API (Printposs) — mã ${remote.order_number}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

async function refreshOne(token: string, push: PushRow) {
  const remote = push.supplierOrderCode ? await getPrintpossOrder(token, push.supplierOrderCode) : await findPrintpossOrder(token, push.externalOrderId)
  const lastSyncedAt = new Date()
  if (!remote) {
    // No documented consistency bound: a missing order never releases an uncertain create automatically.
    await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { lastSyncedAt, error: 'Chưa tìm thấy đơn trên Printposs — giữ khóa gửi trùng, đối chiếu với xưởng' } })
    return { found: false, shipments: 0 }
  }
  if (remote.external_order_id !== push.externalOrderId) throw new PushError('Đơn Printposs không khớp mã ngoài — không cập nhật', 409, 'REMOTE_MISMATCH')
  const cancelled = ['cancelled', 'canceled'].includes(remote.order_status ?? '')
  await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { ...landed(remote), lastSyncedAt, status: 'CREATED',
    error: cancelled ? 'Printposs đã huỷ đơn — đối chiếu với xưởng trước khi mở lại dòng sản xuất' : null, responseJson: JSON.stringify(remote) } })
  if (!push.exportMarked) await markPushExported(push)
  const request = JSON.parse(push.requestJson) as PrintpossPayload
  const lineIds: string[] = JSON.parse(push.prevExportJson ?? '{}').shopifyLineIds ?? []
  const tracking = printpossTrackingFor(request.items, lineIds, remote)
  const shipments = await upsertLineTracking(push, line => line.qty === request.items[lineIds.indexOf(line.shopifyLineId)]?.quantity ? tracking.get(line.shopifyLineId) ?? null : null)
  if (!cancelled && remote.packages.some(p => p.tracking_number) && tracking.size < lineIds.length) {
    await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: 'Tracking chưa ghép đủ số lượng/đúng item hoặc một dòng có nhiều kiện — kiểm tra và nhập tracking thủ công' } })
  }
  return { found: true, shipments }
}

export async function refreshPrintpossPush(orderId: string) {
  const supplier = await findPrintpossSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn chưa từng gửi Printposs', 404, 'NOT_FOUND')
  const result = await refreshOne(await tokenOrThrow(), push)
  return { ...result, push: await viewOf(push.id) }
}

export async function syncPrintpossTracking() {
  const [supplier, settings] = await Promise.all([findPrintpossSupplier(), getPrintpossSettings()])
  if (!supplier || !settings.token) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Printposs supplier/token' }
  const pushes = await prisma.supplierOrderPush.findMany({ where: { supplierId: supplier.id, status: { in: ['SENDING', 'CREATED'] },
    pushedAt: { gte: new Date(Date.now() - 90 * 86400_000) }, order: { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } } } })
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    try {
      const result = await refreshOne(settings.token, push)
      found += Number(result.found)
      shipments += result.shipments
    } catch {
      await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: 'Không đồng bộ được Printposs — thử cập nhật trạng thái lại' } })
    }
  }
  return { pushes: pushes.length, found, shipments }
}
