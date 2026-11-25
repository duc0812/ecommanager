import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { currentFiles } from '@/lib/task-files'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import { logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { checkOrderForPush, closeCancelledPush, collectLineFiles, isActive, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow } from '@/lib/repos/supplier-push-core'
import { getToadditSettings, hasToadditCredentials } from '@/lib/toaddit-settings'
import { isToadditSupplier, validToadditVariantId, type ToadditPreviewInfo } from '@/lib/toaddit-shared'
import { cancelToadditOrder, createToadditOrder, findToadditOrder, listToadditProducts, toadditAccount, toadditAccountId, ToadditError, toadditStatus, toadditTracking, type ToadditAccount, type ToadditOrder, type ToadditOrderPayload } from '@/lib/toaddit'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview } from '@/lib/pgprints-shared'
import { productsWithSuggestions, upsertProductMapping } from '@/lib/repos/suppliers'

const DUPLICATE = 'Đơn đã có lần gửi Toaddit đang hiệu lực — không gửi trùng'
type Snapshot = { protocol: 'ros-v1'; request: ToadditOrderPayload; accountId: string; lineIds: string[] }
export type ToadditSelection = Record<string, string>
export function parseToadditSelection(value: unknown): ToadditSelection {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new PushError('Danh sách sản phẩm Toaddit ROS không hợp lệ', 400, 'BAD_SELECTION')
  const selection: ToadditSelection = {}
  for (const [key, id] of Object.entries(value)) {
    if (key.length > 200 || !key || !validToadditVariantId(id)) throw new PushError('Mã sản phẩm/size Toaddit ROS không hợp lệ', 400, 'BAD_SELECTION')
    Object.defineProperty(selection, key, { value: id, enumerable: true, writable: true })
  }
  return selection
}
export async function findToadditSupplier() {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const matches = all.filter(s => s.isActive && isToadditSupplier(s))
  if (matches.length > 1) throw new PushError('Có nhiều xưởng Toaddit đang hoạt động — kiểm tra cấu hình', 409, 'SUPPLIER_CONFLICT')
  return matches[0] ?? null
}
export async function toadditCatalog() {
  const variants = await listToadditProducts(await toadditAccount())
  const supplier = await findToadditSupplier()
  const supplierSkus = variants.filter(t => t.active).map(t => ({ skuName: t.id, skuCode: t.sku, productName: `${t.productCode} · ${t.size} · ${t.name}${t.color ? ' · ' + t.color : ''}` }))
  return { variants, supplierSkus, products: supplier ? await productsWithSuggestions(supplier.id, supplierSkus) : [] }
}
export async function syncToadditCatalog() {
  const { variants } = await toadditCatalog()
  const active = variants.filter(t => t.active && t.baseCost !== null)
  if (new Set(active.map(t => t.sku)).size !== active.length) throw new PushError('Catalog ROS có SKU nội bộ trùng — đối chiếu trước khi nhập', 502, 'BAD_CATALOG')
  const supplier = await findToadditSupplier() ?? await prisma.supplier.upsert({ where: { code: 'toaddit' },
    create: { name: 'Toaddit', code: 'toaddit', apiType: 'toaddit' }, update: { isActive: true, apiType: 'toaddit' } })
  for (const t of active) await upsertProductMapping({ supplierId: supplier.id, sku: t.sku, apiSku: t.id, baseCost: t.baseCost!,
    productName: t.name, requiresDesign: true, currency: 'USD', baseSku: t.productCode,
    variant1Name: 'Size', variant1Value: t.size, variant2Name: 'Color', variant2Value: t.color || null })
  return { supplierId: supplier.id, imported: active.length, skipped: variants.length - active.length }
}
export async function checkToadditConnection() {
  const variants = await listToadditProducts(await toadditAccount())
  return { variants: variants.length, activeVariants: variants.filter(t => t.active).length }
}
function accountCheck(push: PushRow, account: ToadditAccount): Snapshot {
  let snapshot: Snapshot | null = null
  try { snapshot = JSON.parse(push.requestJson) } catch {}
  if (snapshot?.protocol !== 'ros-v1') throw new PushError('Lần gửi này thuộc API Toaddit cũ — đối chiếu thủ công, không gửi lại bằng ROS', 409, 'LEGACY_PUSH')
  if (!snapshot.request || snapshot.accountId !== toadditAccountId(account)) throw new PushError('API key ROS đã đổi sau lần gửi — khôi phục đúng key để đối chiếu', 409, 'ACCOUNT_CHANGED')
  return snapshot
}
type Built = { preview: PushPreview & { toaddit: ToadditPreviewInfo; estimate: { goods: number | null; wallet: null; note: string } }; rawBody: string | null; externalOrderId: string; supplierId: string | null; snapshot: Snapshot | null }
export async function buildToadditPush(orderId: string, selection: ToadditSelection = {}): Promise<Built | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null
  const [settings, supplier] = await Promise.all([getToadditSettings(), findToadditSupplier()])
  const account = hasToadditCredentials(settings) ? settings as ToadditAccount : null
  const pushes = supplier ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } }) : []
  const own = order.lines.filter(l => !isNonProductLine(l) && l.resolvedSupplierId === supplier?.id)
  const plan = planPushLines(order, own.filter(l => !l.dropship), pushes)
  const active = plan.later ? null : pushes.find(p => isActive(p.status)) ?? null
  // Distinguish identical order numbers across stores and suppliers, including uncertain-create reconciliation.
  const orderCode = `TD-${order.shopifyOrderNumber.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}-${hashPayload(JSON.stringify([order.storeId, orderId])).slice(0, 12)}`
  const externalOrderId = await nextExternalOrderId(orderCode, { orderId, supplierId: supplier?.id ?? null, later: plan.later })
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }
  const { baseUrl, keyOf } = await checkOrderForPush(order, supplier, { name: 'Toaddit ROS', active, externalOrderId, lines: plan.lines, held: plan.held }, { error, warning })
  if (!account) error('NO_CREDENTIALS', 'Chưa lưu API key Toaddit ROS ở Setup › Fulfill')
  if (!plan.lines.length && !active) error('NO_LINES', 'Không có dòng Toaddit đã duyệt và chưa gửi')
  if (Object.keys(selection).some(key => !plan.lines.some(l => l.shopifyLineId === key))) error('BAD_SELECTION', 'Sản phẩm được chọn chứa dòng không thuộc lần gửi này')
  for (const push of pushes.filter(p => isActive(p.status))) {
    if (account) try { accountCheck(push, account) } catch (e: any) { error(e.code ?? 'ACCOUNT_CHANGED', e.message) }
  }
  let variants: Awaited<ReturnType<typeof listToadditProducts>> = []
  let catalogLoaded = false
  if (account && !active && plan.lines.length) {
    try { variants = await listToadditProducts(account); catalogLoaded = true }
    catch (e: any) { error('CATALOG', `Không đọc được catalog ROS: ${e.message}`) }
  }
  const skus = plan.lines.flatMap(l => l.resolvedSupplierSku ? [l.resolvedSupplierSku] : [])
  const products = supplier ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: skus } } }) : []
  const lines: PreviewLine[] = [], choices: ToadditPreviewInfo['products'] = []
  const picked: typeof variants = [], items: ToadditOrderPayload['items'] = []
  const methods = new Set<number>()
  let goods: number | null = 0
  const country = countryCodeOf(order.shippingCountry)
  for (const l of plan.lines) {
    const refId = keyOf(l), product = products.find(p => p.sku === l.resolvedSupplierSku)
    const variantId = selection[l.shopifyLineId] ?? product?.apiSku ?? ''
    const variant = variants.find(t => t.id === variantId && t.active)
    if (!variant && !active && catalogLoaded) {
      const reason = !variantId ? 'chưa ghép mã sản phẩm và size ROS'
        : !validToadditVariantId(variantId) ? 'mapping đang dùng ID API cũ hoặc không hợp lệ; ghép lại mã sản phẩm và size ROS'
          : 'mã sản phẩm và size đã ghép không có trong catalog ROS đang bán; kiểm tra lại với xưởng'
      error('PRODUCT_UNAVAILABLE', `${refId}: ${reason}`, refId)
    }
    const approved = isLineApproved(l, order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId))
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt`, refId)
    const files = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: 'Toaddit ROS' }, { error, warning })
    if (!files.templateName) error('NO_TEMPLATE', `${refId}: cần gán template in đúng sản phẩm trước khi gửi`, refId)
    if (files.prints.length !== 1 || !files.prints[0]?.publicUrl) error('PRINT_SHEET', `${refId}: ROS nhận một designLink; cần đúng một file in trọn sheet theo template`, refId)
    if (files.files.some(f => f.sizeOk === false)) error('SIZE_MISMATCH', `${refId}: file in sai khổ template`, refId)
    const mockup = currentFiles(order.artworks.filter(a => a.shopifyLineId === l.shopifyLineId), 'MOCKUP')
      .some(a => a.mimeType === 'image/png' || a.mimeType === 'image/jpeg')
    if (!mockup || !files.image) error('NO_MOCKUP', `${refId}: cần mockup của đơn đã duyệt, đúng custom/no-name`, refId)
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) error('QUANTITY', `${refId}: số lượng phải là số nguyên dương`, refId)
    const method = product?.apiShipClass?.trim() || settings.shippingMethod
    if (!['1', '2', '3'].includes(method)) error('SHIPPING', `${refId}: ship ROS chỉ nhận 1, 2 hoặc 3`, refId)
    methods.add(Number(method))
    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length && (!country || !shipCountries.includes(country))) error('SHIP_COUNTRY', `${refId}: SKU chỉ giao tới ${shipCountries.join(', ')}`, refId)
    if (l.designNote?.trim()) warning('DESIGN_NOTE', `${refId}: ghi chú nội bộ không gửi sang Toaddit`, refId)
    items.push({ sku: l.sku?.trim() || refId, productCode: variant?.productCode ?? '', size: variant?.size ?? '', quantity: l.qty,
      designLink: files.prints[0]?.publicUrl ?? '', urlMockup: files.image ?? '' })
    if (variant) {
      choices.push({ refId, shopifyLineId: l.shopifyLineId, variantId: variant.id, productCode: variant.productCode, size: variant.size, name: variant.name })
      picked.push(variant)
      goods = goods === null || variant.baseCost === null ? null : goods + variant.baseCost * l.qty
    } else goods = null
    lines.push({ refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle,
      quantity: l.qty, supplierSku: l.resolvedSupplierSku, apiSku: variant ? `${variant.productCode} · ${variant.size}` : null,
      shipClass: method, shipClassSource: product?.apiShipClass ? 'product' : 'default', shipCountries,
      templateName: files.templateName, mockupUrl: files.mockupUrl, designNote: l.designNote, files: files.files })
  }
  if (methods.size > 1) error('SHIPPING_MIXED', 'Các dòng Toaddit phải dùng chung một phương thức ship cho mỗi lần gửi')
  const payload: ToadditOrderPayload = {
    orderCode: externalOrderId, deliveryShippingType: (methods.values().next().value ?? 1) as 1 | 2 | 3, items,
    logistics: { consignee: (order.shippingName ?? order.customerName ?? '').trim(), phone: order.shippingPhone?.trim() ?? '', countryCode: country ?? '',
      province: resolveStateCode({ countryCode: country, stateCode: order.shippingStateCode, state: order.shippingState }) ?? order.shippingState?.trim() ?? '',
      city: order.shippingCity?.trim() ?? '', address1: order.shippingAddress1?.trim() ?? '', address2: order.shippingAddress2?.trim() || undefined, postcode: order.shippingZip?.trim() ?? '' },
  }
  for (const field of ['consignee', 'phone', 'countryCode', 'province', 'city', 'address1', 'postcode'] as const) {
    if (!payload.logistics[field]) error('ADDRESS', `Thông tin ROS ${field} bắt buộc — bổ sung thông tin thật trước khi gửi`)
  }
  const rawBody = items.length ? JSON.stringify(payload) : null
  const snapshot: Snapshot | null = account && rawBody ? { protocol: 'ros-v1', request: payload, accountId: toadditAccountId(account), lineIds: plan.lines.map(l => l.shopifyLineId) } : null
  const payloadHash = snapshot ? hashPayload(JSON.stringify({ snapshot, variants: picked, localFiles: lines.map(l => ({ id: l.shopifyLineId, files: l.files, mockup: l.mockupUrl })) })) : null
  const history = await toPushViews(pushes)
  return { rawBody, externalOrderId, supplierId: supplier?.id ?? null, snapshot, preview: {
    order: { id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus, storeName: order.store.project?.name ?? order.store.shop },
    supplier, pushEnabled: !!account, hasCredentials: !!account, canPush: !!rawBody && !issues.some(i => i.level === 'error'), payload: items.length ? payload : null,
    payloadHash, lines, issues, balance: null, activePush: history.find(p => isActive(p.status)) ?? null, laterSend: plan.later, history,
    estimate: { goods, wallet: null, note: 'Ước tính từ catalog, chưa gồm ship/thuế. Tool không gửi giá ghi đè hoặc tự thanh toán.' },
    toaddit: { protocol: 'ros-v1', products: choices, options: variants.filter(t => t.active).map(t => ({ id: t.id, productCode: t.productCode, size: t.size, name: t.name })) },
  } }
}
function landed(remote: ToadditOrder) {
  return { supplierOrderCode: remote.code, supplierInternalId: remote.id, remoteStatus: toadditStatus(remote) }
}
function verifyRemote(remote: ToadditOrder, snapshot: Snapshot, id?: string | null) {
  const totals = (items: any[]) => {
    const sums = new Map<string, number>()
    for (const item of items) {
      if (![item.sku, item.productCode, item.size].every(v => typeof v === 'string' && !!v) || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1) return null
      const key = JSON.stringify([item.sku, item.productCode, item.size])
      sums.set(key, (sums.get(key) ?? 0) + Number(item.quantity))
    }
    return JSON.stringify(Array.from(sums.entries()).sort())
  }
  const expected = totals(snapshot.request.items)
  if ((id && remote.id !== id) || remote.code !== snapshot.request.orderCode || !Array.isArray(remote.raw.itemList) || !expected || totals(remote.raw.itemList) !== expected) {
    throw new PushError('ID/mã đơn hoặc SKU, size, số lượng ROS không khớp lần gửi — cần đối chiếu thủ công', 409, 'REMOTE_MISMATCH')
  }
}
export async function pushToadditOrder(orderId: string, input: { payloadHash: string; userId: string | null; confirmArtwork: boolean; variantIds?: ToadditSelection }) {
  if (!input.confirmArtwork) throw new PushError('Cần đối chiếu sản phẩm, file in và mockup ROS trước khi gửi', 400, 'ARTWORK_NOT_CONFIRMED')
  const account = await toadditAccount(), built = await buildToadditPush(orderId, input.variantIds)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length || !built.rawBody || !built.supplierId || !built.snapshot) throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Toaddit ROS', 422, 'NOT_ELIGIBLE', errors)
  if (input.payloadHash !== built.preview.payloadHash || built.snapshot.accountId !== toadditAccountId(account)) throw new PushError('Nội dung hoặc sản phẩm ROS đã đổi — mở lại bản xem trước', 409, 'PAYLOAD_CHANGED')
  const reserved = await reservePush({ orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId,
    lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: JSON.stringify(built.snapshot), userId: input.userId }, DUPLICATE)
  let remote: ToadditOrder
  let creating = false
  try {
    const existing = await findToadditOrder(account, built.externalOrderId)
    if (existing) throw new PushError('ROS đã có mã đơn này — đối chiếu trước khi gửi', 409, 'REMOTE_EXISTS')
    creating = true
    const created = await createToadditOrder(account, built.rawBody)
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { supplierInternalId: created.id, supplierOrderCode: created.code, responseJson: JSON.stringify(created.raw) } })
    const found = await findToadditOrder(account, built.externalOrderId)
    if (!found) throw new ToadditError('ROS đã nhận ID đơn nhưng chưa trả danh sách — cập nhật trạng thái để đối chiếu', 502, null, true)
    verifyRemote(found, built.snapshot, created.id)
    if (found.status === 80) throw new ToadditError('ROS trả đơn đã huỷ — đối chiếu trước khi gửi lại', 409, null, true)
    remote = found
  } catch (e: any) {
    const unknown = (e instanceof PushError && e.code === 'REMOTE_EXISTS') || (creating && (!(e instanceof ToadditError) || e.unknownOutcome))
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: unknown ? `${e.message}. Giữ khóa chống trùng; cập nhật trạng thái để đối chiếu` : e.message, ...(!unknown ? { status: 'FAILED', activeKey: null } : {}) } })
    throw new PushError(e.message, unknown ? 504 : 502, unknown ? 'UNKNOWN_RESULT' : 'CREATE_FAILED')
  }
  await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { status: 'CREATED', ...landed(remote), error: null, responseJson: JSON.stringify(remote.raw) } })
  const exported = await markPushExported({ ...reserved, orderId, supplierId: built.supplierId, pushedById: input.userId })
  await logHandoffEvent(orderId, `Chuyển supplier qua API (Toaddit ROS) — mã ${remote.code}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}
async function refreshOne(account: ToadditAccount, push: PushRow) {
  const snapshot = accountCheck(push, account), remote = await findToadditOrder(account, push.externalOrderId)
  const lastSyncedAt = new Date()
  if (!remote) {
    await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { lastSyncedAt, error: 'Chưa tìm thấy đơn ROS — giữ khóa chống trùng, đối chiếu với xưởng' } })
    return { found: false, shipments: 0 }
  }
  verifyRemote(remote, snapshot, push.supplierInternalId)
  await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { status: 'CREATED', ...landed(remote), lastSyncedAt,
    error: remote.status === 80 ? 'ROS đã huỷ đơn — bấm Huỷ để đối chiếu và đưa dòng về chờ gửi' : null, responseJson: JSON.stringify(remote.raw) } })
  if (!push.exportMarked && remote.status !== 80) await markPushExported(push)
  const tracking = toadditTracking(remote)
  const shipments = tracking ? await upsertLineTracking(push, line => {
    const index = snapshot.lineIds.indexOf(line.shopifyLineId)
    return line.qty === snapshot.request.items[index]?.quantity ? tracking : null
  }) : 0
  if (remote.status === 70 && remote.tracking && !tracking) await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: 'ROS trả nhiều mã hoặc tracking chưa đọc được — kiểm tra và nhập từng kiện thủ công' } })
  return { found: true, shipments }
}
export async function refreshToadditPush(orderId: string) {
  const supplier = await findToadditSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn chưa từng gửi Toaddit', 404, 'NOT_FOUND')
  const result = await refreshOne(await toadditAccount(), push)
  return { ...result, push: await viewOf(push.id) }
}
export async function cancelToadditPush(orderId: string) {
  const supplier = await findToadditSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Toaddit đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả gửi — cập nhật trạng thái trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const account = await toadditAccount(), snapshot = accountCheck(push, account)
  const remote = await findToadditOrder(account, push.externalOrderId)
  if (!remote) throw new PushError('Không đối chiếu được đơn ROS — chưa huỷ ở tool', 409, 'REMOTE_MISMATCH')
  verifyRemote(remote, snapshot, push.supplierInternalId)
  if (remote.status !== 80) {
    await cancelToadditOrder(account, remote.id)
    const after = await findToadditOrder(account, push.externalOrderId)
    if (!after) throw new PushError('ROS chưa xác nhận huỷ — giữ trạng thái đã gửi', 409, 'CANCEL_UNCONFIRMED')
    verifyRemote(after, snapshot, remote.id)
    if (after.status !== 80) throw new PushError('ROS chưa xác nhận huỷ — giữ trạng thái đã gửi', 409, 'CANCEL_UNCONFIRMED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Toaddit ROS — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}
export async function syncToadditTracking() {
  const [supplier, settings] = await Promise.all([findToadditSupplier(), getToadditSettings()])
  if (!supplier || !hasToadditCredentials(settings)) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Toaddit ROS supplier/credentials' }
  const account = settings as ToadditAccount
  const pushes = await prisma.supplierOrderPush.findMany({ where: { supplierId: supplier.id, status: { in: ['SENDING', 'CREATED'] },
    pushedAt: { gte: new Date(Date.now() - 90 * 86400_000) }, order: { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } } } })
  let found = 0, shipments = 0
  for (const push of pushes) {
    try { const result = await refreshOne(account, push); found += Number(result.found); shipments += result.shipments }
    catch (e: any) { await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: e instanceof PushError ? e.message : 'Không đồng bộ được Toaddit ROS — kiểm tra tài khoản và cập nhật lại' } }) }
  }
  return { pushes: pushes.length, found, shipments }
}
