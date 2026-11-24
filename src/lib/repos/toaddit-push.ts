import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import { logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { checkOrderForPush, closeCancelledPush, collectLineFiles, isActive, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow } from '@/lib/repos/supplier-push-core'
import { getToadditSettings, hasToadditCredentials } from '@/lib/toaddit-settings'
import { isToadditSupplier, toadditId, type ToadditPreviewInfo } from '@/lib/toaddit-shared'
import { cancelToadditOrder, createToadditOrder, findToadditOrder, getToadditTracking, listToadditTemplates, toadditAccount, toadditAccountId, ToadditError, toadditStatus, toadditTracking, type ToadditAccount, type ToadditOrder, type ToadditOrderPayload, type ToadditTemplate } from '@/lib/toaddit'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview } from '@/lib/pgprints-shared'
import { productsWithSuggestions, upsertProductMapping } from '@/lib/repos/suppliers'

const DUPLICATE = 'Đơn đã có lần gửi Toaddit đang hiệu lực — không gửi trùng'
type Snapshot = { request: ToadditOrderPayload; accountId: string; lineIds: string[] }
export type ToadditSelection = Record<string, string>
export function parseToadditSelection(value: unknown): ToadditSelection {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new PushError('Danh sách mẫu Toaddit không hợp lệ', 400, 'BAD_SELECTION')
  const selection: ToadditSelection = {}
  for (const [key, id] of Object.entries(value)) {
    if (key.length > 200 || !key || typeof id !== 'string' || !toadditId(id)) throw new PushError('ID dòng/mẫu Toaddit không hợp lệ', 400, 'BAD_SELECTION')
    Object.defineProperty(selection, key, { value: id, enumerable: true, writable: true })
  }
  return selection
}

export async function findToadditSupplier() {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  return all.find(s => s.isActive && isToadditSupplier(s)) ?? null
}

export async function toadditCatalog() {
  const account = await toadditAccount()
  const templates = await listToadditTemplates(account)
  const supplier = await findToadditSupplier()
  const supplierSkus = templates.filter(t => t.active).map(t => ({ skuName: t.id, skuCode: t.sku, productName: `${t.name} · ${t.style} · ${t.size} · ${t.sku}` }))
  return { templates, supplierSkus, products: supplier ? await productsWithSuggestions(supplier.id, supplierSkus) : [] }
}

export async function syncToadditCatalog() {
  if ((await getToadditSettings()).environment === 'sandbox') throw new PushError('Sandbox chỉ kiểm tra kết nối; chuyển production trước khi nhập SKU vào xưởng thật', 409, 'SANDBOX')
  const { templates } = await toadditCatalog()
  const active = templates.filter(t => t.active && t.baseCost !== null && t.baseCost >= 0)
  if (new Set(active.map(t => t.sku)).size !== active.length) throw new PushError('Toaddit có SKU mẫu trùng — sửa SKU bên Toaddit trước khi nhập', 502, 'BAD_CATALOG')
  const supplier = await findToadditSupplier() ?? await prisma.supplier.upsert({ where: { code: 'toaddit' },
    create: { name: 'Toaddit', code: 'toaddit', apiType: 'toaddit' }, update: { isActive: true, apiType: 'toaddit' } })
  for (const t of active) await upsertProductMapping({ supplierId: supplier.id, sku: t.sku, apiSku: t.id, baseCost: t.baseCost!,
    productName: `${t.name} · ${t.style} · ${t.size}`, requiresDesign: true, currency: 'USD',
    variant1Name: 'Size', variant1Value: t.size, variant2Name: 'Style', variant2Value: t.style })
  return { supplierId: supplier.id, imported: active.length, skipped: templates.length - active.length }
}

export async function checkToadditConnection() {
  const templates = await listToadditTemplates(await toadditAccount())
  return { templates: templates.length, activeTemplates: templates.filter(t => t.active).length }
}

function accountCheck(push: PushRow, account: ToadditAccount): Snapshot {
  let snapshot: Snapshot | null = null
  try { snapshot = JSON.parse(push.requestJson) } catch {}
  if (!snapshot?.request || snapshot.accountId !== toadditAccountId(account)) throw new PushError('Tài khoản hoặc môi trường Toaddit đã đổi sau lần gửi — khôi phục đúng tài khoản để đối chiếu', 409, 'ACCOUNT_CHANGED')
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
  const externalOrderId = await nextExternalOrderId(order.shopifyOrderNumber.replace(/^#/, ''), { orderId, supplierId: supplier?.id ?? null, later: plan.later })
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }
  const { baseUrl, keyOf } = await checkOrderForPush(order, supplier, { name: 'Toaddit', active, externalOrderId, lines: plan.lines, held: plan.held }, { error, warning })
  if (!account) error('NO_CREDENTIALS', 'Chưa lưu App Key / App Secret Toaddit ở Setup › Fulfill')
  if (!plan.lines.length && !active) error('NO_LINES', 'Không có dòng Toaddit đã duyệt và chưa gửi')
  if (externalOrderId.length > 100) error('ORDER_CODE', 'Mã đơn Toaddit vượt 100 ký tự')
  if (Object.keys(selection).some(key => !plan.lines.some(l => l.shopifyLineId === key))) error('BAD_SELECTION', 'Mẫu được chọn chứa dòng không thuộc lần gửi này')
  for (const push of pushes.filter(p => isActive(p.status))) {
    if (account) try { accountCheck(push, account) } catch (e: any) { error('ACCOUNT_CHANGED', e.message) }
  }
  let templates: ToadditTemplate[] = []
  if (account && !active && plan.lines.length) {
    try { templates = await listToadditTemplates(account) }
    catch (e: any) { error('CATALOG', `Không đọc được mẫu Toaddit: ${e.message}`) }
  }
  const skus = plan.lines.flatMap(l => l.resolvedSupplierSku ? [l.resolvedSupplierSku] : [])
  const products = supplier ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: skus } } }) : []
  const lines: PreviewLine[] = []
  const choices: ToadditPreviewInfo['templates'] = []
  const picked: ToadditTemplate[] = []
  const items: ToadditOrderPayload['items'] = []
  const methods = new Set<number>()
  let goods: number | null = 0
  const country = countryCodeOf(order.shippingCountry)
  for (const l of plan.lines) {
    const refId = keyOf(l)
    const product = products.find(p => p.sku === l.resolvedSupplierSku)
    const templateId = selection[l.shopifyLineId] ?? toadditId(product?.apiSku)
    const template = templates.find(t => t.id === templateId)
    if (!templateId) error('NO_TEMPLATE_SKU', `${refId}: chưa ghép ID mẫu Toaddit — chọn mẫu đã hoàn tất đúng thiết kế`, refId)
    else if (!template?.active && !active) error('TEMPLATE_UNAVAILABLE', `${refId}: mẫu ${templateId} không tồn tại, ngừng bán hoặc Toaddit yêu cầu thiết kế lại`, refId)
    if (template && !template.images.length) error('NO_REMOTE_PREVIEW', `${refId}: mẫu Toaddit không có ảnh để đối chiếu — hoàn tất mẫu trên Toaddit`, refId)
    const approved = isLineApproved(l, order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId))
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt`, refId)
    const files = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: 'Toaddit' }, { error, warning })
    if (!Number.isSafeInteger(l.qty) || l.qty < 1 || l.qty > 999) error('QUANTITY', `${refId}: Toaddit nhận số lượng nguyên từ 1 đến 999`, refId)
    const method = product?.apiShipClass?.trim() || settings.shippingMethod
    if (!['1', '2'].includes(method)) error('SHIPPING', `${refId}: phương thức ship Toaddit chỉ nhận 1 (standard) hoặc 2 (express)`, refId)
    methods.add(Number(method))
    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length && (!country || !shipCountries.includes(country))) error('SHIP_COUNTRY', `${refId}: SKU chỉ giao tới ${shipCountries.join(', ')}`, refId)
    if (l.designNote?.trim()) warning('DESIGN_NOTE', `${refId}: ghi chú nội bộ không gửi sang Toaddit`, refId)
    for (const f of files.files) if (f.sizeOk === false && order.artworks.find(a => a.id === f.artworkId)?.source === 'AUTO') error('SIZE_MISMATCH_AUTO', `${refId}: file AUTO sai khổ template — kiểm tra lại`, refId)
    items.push({ specificProductId: templateId ?? '', count: l.qty })
    if (template) {
      choices.push({ refId, shopifyLineId: l.shopifyLineId, templateId: template.id, name: `${template.name} · ${template.style} · ${template.size}`, sku: template.sku, images: template.images })
      picked.push(template)
      goods = goods === null || template.baseCost === null ? null : goods + template.baseCost * l.qty
    } else goods = null
    lines.push({ refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle,
      quantity: l.qty, supplierSku: l.resolvedSupplierSku, apiSku: templateId, shipClass: method, shipClassSource: product?.apiShipClass ? 'product' : 'default',
      shipCountries, templateName: files.templateName, mockupUrl: files.mockupUrl, designNote: l.designNote, files: files.files })
  }
  if (methods.size > 1) error('SHIPPING_MIXED', 'Các dòng Toaddit phải dùng chung một phương thức ship cho mỗi lần gửi')
  if (goods !== null && goods >= 200) error('WHOLESALE', 'Giá sản phẩm từ 200 USD có thể là đơn wholesale — xử lý đặt hàng trên Toaddit theo tài liệu API')
  warning('TEMPLATE_ARTWORK', 'Toaddit in từ mẫu đã lưu trên Toaddit. File in trong tool chỉ để đối chiếu; xác nhận ảnh mẫu, size, màu và tên cá nhân hoá trước khi gửi')
  if (settings.environment === 'sandbox') error('SANDBOX', 'Sandbox chỉ kiểm tra kết nối — không gửi đơn hoặc đánh dấu xuất xưởng trong dữ liệu thật')
  const payload: ToadditOrderPayload = {
    externalOrderCode: externalOrderId, deliveryShippingType: methods.has(2) ? 2 : 1, isPayment: settings.payOnCreate ? 1 : 0, items,
    logistics: { consignee: (order.shippingName ?? order.customerName ?? '').trim(), phone: order.shippingPhone?.trim() ?? '', countryCode: country ?? '',
      province: resolveStateCode({ countryCode: country, stateCode: order.shippingStateCode, state: order.shippingState }) ?? order.shippingState?.trim() ?? '',
      city: order.shippingCity?.trim() ?? '', addr1: order.shippingAddress1?.trim() ?? '', addr2: order.shippingAddress2?.trim() || undefined, postcode: order.shippingZip?.trim() ?? '' },
  }
  for (const [field, max] of Object.entries({ consignee: 64, phone: 64, countryCode: 64, province: 64, city: 64, addr1: 300, postcode: 16 })) {
    const value = payload.logistics[field as keyof typeof payload.logistics]
    if (!value || value.length > max) error('ADDRESS', `Thông tin Toaddit ${field} bắt buộc, tối đa ${max} ký tự`)
  }
  if ((payload.logistics.addr2?.length ?? 0) > 200) error('ADDRESS', 'Địa chỉ dòng 2 Toaddit tối đa 200 ký tự')
  const rawBody = items.length ? JSON.stringify(payload) : null
  const snapshot: Snapshot | null = account && rawBody ? { request: payload, accountId: toadditAccountId(account), lineIds: plan.lines.map(l => l.shopifyLineId) } : null
  const payloadHash = snapshot ? hashPayload(JSON.stringify({ snapshot, templates: picked, localFiles: lines.map(l => ({ id: l.shopifyLineId, files: l.files, mockup: l.mockupUrl })) })) : null
  const history = await toPushViews(pushes)
  return { rawBody, externalOrderId, supplierId: supplier?.id ?? null, snapshot, preview: {
    order: { id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus, storeName: order.store.project?.name ?? order.store.shop },
    supplier, pushEnabled: !!account, hasCredentials: !!account, canPush: !!rawBody && !issues.some(i => i.level === 'error'), payload: items.length ? payload : null,
    payloadHash, lines, issues, balance: null, activePush: history.find(p => isActive(p.status)) ?? null, laterSend: plan.later, history,
    estimate: { goods, wallet: null, note: 'Giá mẫu trong catalog, chưa gồm phí ship và thuế. Kiểm tra tổng tiền cuối cùng trên Toaddit.' },
    toaddit: { environment: settings.environment, payOnCreate: settings.payOnCreate, templates: choices,
      options: templates.filter(t => t.active).map(t => ({ id: t.id, sku: t.sku, name: `${t.name} · ${t.style} · ${t.size}` })) },
  } }
}

function landed(remote: ToadditOrder) {
  return { supplierOrderCode: remote.code, supplierInternalId: remote.id, remoteStatus: toadditStatus(remote), totalCost: remote.total, shippingFee: remote.freight }
}

export async function pushToadditOrder(orderId: string, input: { payloadHash: string; userId: string | null; confirmTemplates: boolean; templateIds?: ToadditSelection }) {
  if (!input.confirmTemplates) throw new PushError('Cần xác nhận mẫu Toaddit khớp thiết kế đã duyệt', 400, 'TEMPLATE_NOT_CONFIRMED')
  const account = await toadditAccount()
  const built = await buildToadditPush(orderId, input.templateIds)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length || !built.rawBody || !built.supplierId || !built.snapshot) throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Toaddit', 422, 'NOT_ELIGIBLE', errors)
  if (input.payloadHash !== built.preview.payloadHash || built.snapshot.accountId !== toadditAccountId(account)) throw new PushError('Nội dung hoặc mẫu Toaddit đã đổi — mở lại bản xem trước', 409, 'PAYLOAD_CHANGED')
  const reserved = await reservePush({ orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId,
    lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: JSON.stringify(built.snapshot), userId: input.userId }, DUPLICATE)
  let remote: ToadditOrder
  let creating = false
  try {
    remote = (await findToadditOrder(account, built.externalOrderId))!
    if (remote) throw new PushError('Toaddit đã có mã đơn ngoài này — đối chiếu trước khi gửi', 409, 'REMOTE_EXISTS')
    creating = true
    remote = await createToadditOrder(account, built.rawBody)
  } catch (e: any) {
    const unknown = e instanceof PushError && e.code === 'REMOTE_EXISTS' || creating && (!(e instanceof ToadditError) || e.unknownOutcome)
    const message = unknown ? `${e.message}. Giữ khóa chống trùng; cập nhật trạng thái để đối chiếu` : e.message
    await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: message, ...(!unknown ? { status: 'FAILED', activeKey: null } : {}) } })
    throw new PushError(message, unknown ? 504 : 502, unknown ? 'UNKNOWN_RESULT' : 'CREATE_FAILED')
  }
  await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { status: 'CREATED', ...landed(remote), error: remote.wholesale ? 'Đơn wholesale — cần hoàn tất trên Toaddit' : null, responseJson: JSON.stringify(remote.raw) } })
  const exported = await markPushExported({ ...reserved, orderId, supplierId: built.supplierId, pushedById: input.userId })
  await logHandoffEvent(orderId, `Chuyển supplier qua API (Toaddit${account.environment === 'sandbox' ? ' sandbox' : ''}) — mã ${remote.code}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

async function refreshOne(account: ToadditAccount, push: PushRow) {
  const snapshot = accountCheck(push, account)
  const remote = await findToadditOrder(account, push.externalOrderId)
  const lastSyncedAt = new Date()
  if (!remote) {
    await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { lastSyncedAt, error: 'Chưa tìm thấy đơn Toaddit — giữ khóa gửi trùng, đối chiếu với xưởng' } })
    return { found: false, shipments: 0 }
  }
  if (push.supplierInternalId && push.supplierInternalId !== remote.id) throw new PushError('ID đơn Toaddit không khớp lần gửi đã lưu', 409, 'REMOTE_MISMATCH')
  const itemTotals = (items: any[]) => {
    const totals = new Map<string, number>()
    for (const item of items) {
      const id = toadditId(item.specificProductId)
      const count = Number(item.count)
      if (!id || !Number.isSafeInteger(count) || count < 1) return null
      totals.set(id, (totals.get(id) ?? 0) + count)
    }
    return JSON.stringify(Array.from(totals.entries()).sort())
  }
  const remoteItems = Array.isArray(remote.raw.items) ? itemTotals(remote.raw.items) : null
  if (!remoteItems || remoteItems !== itemTotals(snapshot.request.items)) throw new PushError('Mẫu/số lượng Toaddit không khớp bản gửi — cần đối chiếu thủ công', 409, 'REMOTE_MISMATCH')
  if (!push.supplierInternalId) {
    const normal = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
    if (!remote.raw.logistics || Object.entries(snapshot.request.logistics).some(([key, value]) => normal(remote.raw.logistics[key]) !== normal(value))) {
      throw new PushError('Địa chỉ đơn Toaddit không khớp lần gửi chưa rõ kết quả — chưa đánh dấu xuất xưởng', 409, 'REMOTE_MISMATCH')
    }
  }
  await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { status: 'CREATED', ...landed(remote), lastSyncedAt,
    error: remote.status === 80 ? 'Toaddit đã huỷ đơn — bấm Huỷ để đối chiếu và đưa dòng về chờ gửi' : remote.wholesale ? 'Đơn wholesale — cần hoàn tất trên Toaddit' : null, responseJson: JSON.stringify(remote.raw) } })
  if (!push.exportMarked && remote.status !== 80) await markPushExported(push)
  if (![70, 90].includes(remote.status ?? -1)) return { found: true, shipments: 0 }
  const rows = await getToadditTracking(account, remote.id)
  const totalQty = snapshot.request.items.reduce((n, i) => n + i.count, 0)
  const tracking = toadditTracking(rows, remote, totalQty)
  const shipments = tracking ? await upsertLineTracking(push, line => {
    const index = snapshot.lineIds.indexOf(line.shopifyLineId)
    return line.qty === snapshot.request.items[index]?.count ? tracking : null
  }) : 0
  if (rows.length && !tracking) await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: 'Tracking Toaddit là mã ảo, chia nhiều kiện hoặc chưa đủ số lượng — kiểm tra và nhập đúng tracking thủ công' } })
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
  const account = await toadditAccount(); accountCheck(push, account)
  const remote = await findToadditOrder(account, push.externalOrderId)
  if (!remote || remote.id !== push.supplierInternalId) throw new PushError('Không đối chiếu được đơn Toaddit — chưa huỷ ở tool', 409, 'REMOTE_MISMATCH')
  if (remote.status !== 80) {
    await cancelToadditOrder(account, remote.id)
    const after = await findToadditOrder(account, push.externalOrderId)
    if (!after || after.id !== remote.id || after.status !== 80) throw new PushError('Toaddit chưa xác nhận huỷ — giữ trạng thái đã gửi', 409, 'CANCEL_UNCONFIRMED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Toaddit — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

export async function syncToadditTracking() {
  const [supplier, settings] = await Promise.all([findToadditSupplier(), getToadditSettings()])
  if (!supplier || !hasToadditCredentials(settings)) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Toaddit supplier/credentials' }
  if (settings.environment === 'sandbox') return { pushes: 0, found: 0, shipments: 0, skipped: 'Toaddit sandbox never feeds Auto Fulfill' }
  const account = settings as ToadditAccount
  const pushes = await prisma.supplierOrderPush.findMany({ where: { supplierId: supplier.id, status: { in: ['SENDING', 'CREATED'] },
    pushedAt: { gte: new Date(Date.now() - 90 * 86400_000) }, order: { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } } } })
  let found = 0; let shipments = 0
  for (const push of pushes) {
    try { const result = await refreshOne(account, push); found += Number(result.found); shipments += result.shipments }
    catch { await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: 'Không đồng bộ được Toaddit — kiểm tra tài khoản và cập nhật lại' } }) }
  }
  return { pushes: pushes.length, found, shipments }
}
