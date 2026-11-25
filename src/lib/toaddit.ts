import { createHash } from 'node:crypto'
import { postToadditRos } from '@/lib/toaddit-transport'
import { getToadditSettings, hasToadditCredentials, type ToadditSettings } from '@/lib/toaddit-settings'
import { TOADDIT_ORIGIN, toadditId, toadditVariantId, validToadditVariantId } from '@/lib/toaddit-shared'

export class ToadditError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null = null, readonly unknownOutcome = false) {
    super(message); this.name = 'ToadditError'
  }
}
export type ToadditAccount = ToadditSettings & { apiKey: string }
export type ToadditProduct = { id: string; sku: string; productCode: string; name: string; size: string; color: string; active: boolean; baseCost: number | null }
export type ToadditOrderItem = { sku: string; productCode: string; size: string; quantity: number; designLink: string; urlMockup: string }
export type ToadditOrderPayload = {
  orderCode: string; deliveryShippingType: 1 | 2 | 3; items: ToadditOrderItem[]
  logistics: { consignee: string; phone: string; countryCode: string; province: string; city: string; address1: string; address2?: string; postcode: string }
}
export type ToadditOrder = { id: string; code: string; status: number | null; tracking: string | null; trackingUrl: string | null; raw: any }
export const toadditNumber = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null
  return Number.isFinite(Number(v)) ? Number(v) : null
}
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
export const toadditAccountId = (s: ToadditAccount) => createHash('sha256').update(JSON.stringify(['ros-v1', TOADDIT_ORIGIN, s.apiKey])).digest('hex')
export async function toadditAccount(): Promise<ToadditAccount> {
  const s = await getToadditSettings()
  if (!hasToadditCredentials(s)) throw new ToadditError('Chưa lưu API key Toaddit ROS ở Setup › Fulfill', 400)
  return s as ToadditAccount
}
export async function callToaddit(account: ToadditAccount, path: string, body: unknown, mutation = false): Promise<any> {
  let reply
  try { reply = await postToadditRos(account.apiKey, `/api/v1${path}`, JSON.stringify(body)) }
  catch { throw new ToadditError('Không kết nối được Toaddit ROS hoặc đã hết thời gian chờ', 0, null, mutation) }
  let json: any = null
  try { json = JSON.parse(reply.text) } catch {}
  const code = toadditNumber(json?.code)
  if (reply.status < 200 || reply.status >= 300 || code !== 0 || Number(json?.success) !== 1) {
    const message = ([str(json?.message), str(json?.detailMessage)].filter(Boolean).join(': ') || `Toaddit ROS trả HTTP ${reply.status}, mã ${code ?? 'không đọc được'}`)
      .split(account.apiKey).join('[redacted]').slice(0, 1500)
    // ROS has no documented create-error catalogue: retain the lock for ambiguous mutation responses.
    const denied = reply.status < 500 && reply.status !== 408 && ([401, 403].includes(reply.status) || code === 1001000)
    throw new ToadditError(message, reply.status || 502, code, mutation && !denied)
  }
  return json
}
async function pages(account: ToadditAccount, path: string, filter: object = {}): Promise<any[]> {
  const out: any[] = []
  for (let pageIndex = 1; pageIndex <= 200; pageIndex++) {
    const body = { ...filter, page: { pageIndex, pageSize: 200 } }
    const reply = path === '/prototype/prototypeList'
      ? await readCatalogPage(account, body)
      : await callToaddit(account, path, body)
    if (!Array.isArray(reply.data)) throw new ToadditError('Toaddit ROS trả danh sách không hợp lệ', 502)
    const total = toadditNumber(reply.page?.total), current = toadditNumber(reply.page?.pageIndex)
    if (current !== null && current !== pageIndex) throw new ToadditError('Toaddit ROS trả sai trang — không dùng danh sách chưa đầy đủ', 502)
    out.push(...reply.data)
    if (!reply.data.length || (total !== null && out.length >= total) || (total === null && reply.data.length < 200)) return out
  }
  throw new ToadditError('Catalog/đơn Toaddit ROS vượt giới hạn phân trang', 502)
}
async function readCatalogPage(account: ToadditAccount, body: object): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try { return await callToaddit(account, '/prototype/prototypeList', body) }
    catch (e) {
      const transient = e instanceof ToadditError && (e.status === 0 || [408, 429].includes(e.status) || e.status >= 500
        || /Service starting|Load balancer does not have available server|prototype-service/i.test(e.message))
      if (!transient) throw e
      if (attempt === 2) throw new ToadditError('Dịch vụ catalog ROS đang tạm thời không khả dụng. Mapping đã lưu được giữ nguyên; thử lại sau khi ROS hoạt động trở lại.', 503)
      // Only retry catalog reads; never replay order mutations or use an unverified cached catalog.
      await new Promise(resolve => setTimeout(resolve, 1100 * (attempt + 1)))
    }
  }
}
export async function listToadditProducts(account: ToadditAccount): Promise<ToadditProduct[]> {
  const rows = await pages(account, '/prototype/prototypeList')
  const out = new Map<string, ToadditProduct>()
  for (const product of rows) {
    if (!Array.isArray(product.productCodeList) || !Array.isArray(product.sizeList)) throw new ToadditError('Catalog Toaddit ROS thiếu mã sản phẩm hoặc size', 502)
    for (const code of product.productCodeList) for (const size of product.sizeList) {
      const productCode = str(code.productCode), sizeName = str(size.sizeName)
      if (!productCode || !sizeName) throw new ToadditError('Catalog Toaddit ROS có mã/size trống', 502)
      const id = toadditVariantId(productCode, sizeName)
      if (!validToadditVariantId(id)) throw new ToadditError('Mã/size Toaddit ROS không hợp lệ hoặc quá dài', 502)
      const price = toadditNumber(size.price)
      const row: ToadditProduct = { id, sku: `${productCode}-${sizeName}`, productCode, size: sizeName, name: str(product.productName) ?? productCode,
        color: str(code.colorName) ?? '', active: Number(product.status) === 1, baseCost: price !== null && price >= 0 ? price : null }
      if (out.has(id) && JSON.stringify(out.get(id)) !== JSON.stringify(row)) throw new ToadditError('Catalog Toaddit ROS có mã/size trùng khác dữ liệu', 502)
      out.set(id, row)
    }
  }
  return Array.from(out.values())
}
export function toadditOrderOf(raw: any): ToadditOrder | null {
  const id = toadditId(raw?.id), code = str(raw?.orderCode)
  if (!id || !code) return null
  return { id, code, status: toadditNumber(raw.status), tracking: str(raw.expressWaybillCode), trackingUrl: str(raw.logisticTrackingUrl), raw }
}
export async function findToadditOrder(account: ToadditAccount, orderCode: string): Promise<ToadditOrder | null> {
  const rows = (await pages(account, '/order/orderList', { orderCode })).filter(r => r.orderCode === orderCode)
  if (rows.length > 1) throw new ToadditError('Toaddit ROS có nhiều đơn cùng mã — đối chiếu thủ công', 409)
  const order = rows.length ? toadditOrderOf(rows[0]) : null
  if (rows.length && !order) throw new ToadditError('Toaddit ROS trả thông tin đơn không hợp lệ', 502)
  return order
}
export async function createToadditOrder(account: ToadditAccount, rawBody: string): Promise<ToadditOrder> {
  const payload = JSON.parse(rawBody) as ToadditOrderPayload
  const reply = await callToaddit(account, '/order/createOrder', payload, true)
  const id = toadditId(reply.data)
  if (!id) throw new ToadditError('Toaddit ROS nhận yêu cầu nhưng thiếu ID đơn — đối chiếu trước khi gửi lại', 502, null, true)
  return { id, code: payload.orderCode, status: null, tracking: null, trackingUrl: null, raw: { id, orderCode: payload.orderCode } }
}
export async function cancelToadditOrder(account: ToadditAccount, id: string): Promise<void> {
  const numericId = Number(id)
  const reply = await callToaddit(account, '/order/cancel', { id: Number.isSafeInteger(numericId) ? numericId : id }, true)
  if (toadditId(reply.data) !== id) throw new ToadditError('Toaddit ROS chưa xác nhận đúng ID huỷ — giữ trạng thái đã gửi', 409, null, true)
}
export function toadditStatus(order: ToadditOrder): string {
  const labels: Record<number, string> = { 14: 'Cần xử lý', 18: 'Chờ duyệt', 42: 'Đang sản xuất', 70: 'Đã gửi hàng', 80: 'Đã huỷ' }
  return order.status === null ? 'Đã nhận đơn — chờ cập nhật' : labels[order.status] ?? `Trạng thái ${order.status}`
}
export function toadditTracking(order: ToadditOrder): { number: string; company: null } | null {
  if (order.status !== 70 || !order.tracking || !/^[A-Za-z0-9][A-Za-z0-9._-]{3,99}$/.test(order.tracking)) return null
  return { number: order.tracking, company: null }
}
