import { createHash, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { postToadditHttp2 } from '@/lib/toaddit-transport'
import { getToadditSettings, hasToadditCredentials, type ToadditSettings } from '@/lib/toaddit-settings'
import { TOADDIT_HOSTS, toadditId } from '@/lib/toaddit-shared'

const PREFIX = '/openapi/toaddit/v1'
export class ToadditError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null = null, readonly unknownOutcome = false) {
    super(message); this.name = 'ToadditError'
  }
}
export type ToadditAccount = ToadditSettings & { appKey: string; appSecret: string }
export type ToadditSession = { accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
export type ToadditTemplate = {
  id: string; collectionId: string; sku: string; name: string; size: string; style: string; active: boolean
  baseCost: number | null; images: string[]; revision: string
}
export type ToadditOrderPayload = {
  externalOrderCode: string; deliveryShippingType: 1 | 2; isPayment: 0 | 1
  items: Array<{ specificProductId: string; count: number }>
  logistics: { consignee: string; phone: string; countryCode: string; province: string; city: string; addr1: string; addr2?: string; postcode: string }
}
export type ToadditOrder = { id: string; code: string; externalOrderCode: string | null; status: number | null; total: number | null; freight: number | null; wholesale: boolean; raw: any }

export const toadditNumber = (v: unknown): number | null => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null
  return Number.isFinite(Number(v)) ? Number(v) : null
}
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
export const toadditAccountId = (s: ToadditAccount) => createHash('sha256').update(JSON.stringify([s.environment, s.appKey, s.appSecret])).digest('hex')

export async function toadditAccount(): Promise<ToadditAccount> {
  const s = await getToadditSettings()
  if (!hasToadditCredentials(s)) throw new ToadditError('Chưa lưu App Key / App Secret Toaddit ở Setup › Fulfill', 400)
  return s as ToadditAccount
}

function scrub(message: string, account: ToadditAccount, session?: ToadditSession) {
  for (const secret of [account.appKey, account.appSecret, session?.accessToken, session?.refreshToken]) if (secret) message = message.split(secret).join('[redacted]')
  return message.slice(0, 1500)
}

async function request(account: ToadditAccount, path: string, body: unknown, session?: ToadditSession, mutation = false): Promise<any> {
  let reply
  try {
    reply = await postToadditHttp2(TOADDIT_HOSTS[account.environment], `${PREFIX}${path}`, {
      'X-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Nonce': randomUUID(), 'X-App-Key': account.appKey,
      ...(session ? { 'X-Access-Token': session.accessToken } : {}),
    }, JSON.stringify(body))
  } catch { throw new ToadditError('Không kết nối được Toaddit qua HTTP/2 hoặc đã hết thời gian chờ', 0, null, mutation) }
  let json: any = null
  try { json = JSON.parse(reply.text) } catch {}
  const code = toadditNumber(json?.code)
  if (reply.status < 200 || reply.status >= 300 || code !== 0) {
    let message = scrub([str(json?.message), str(json?.detailMessage)].filter(Boolean).join(': ') || `Toaddit trả HTTP ${reply.status}, mã ${code ?? 'không đọc được'}`, account, session)
    const refresh = body && typeof body === 'object' ? str((body as any).refreshToken) : null
    if (refresh) message = message.split(refresh).join('[redacted]')
    const definite = code !== null && ((code >= 310100 && code <= 310126) || [310128, 310130, 310134].includes(code) || (code >= 130100 && code <= 130106) || code === 100107)
    const unknown = mutation && (!definite || reply.status >= 500 || reply.status === 408 || !json || code === 310129 || (code !== null && code >= 510100 && code <= 510105))
    throw new ToadditError(message, reply.status || 502, code, unknown)
  }
  return json
}

type SessionGlobals = typeof globalThis & { __toadditSessions?: Map<string, Promise<ToadditSession>> }
const globals = globalThis as SessionGlobals
globals.__toadditSessions ??= new Map()

function parseSession(raw: unknown): ToadditSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as ToadditSession
  return s.accessToken && s.refreshToken && Number.isFinite(s.accessExpiresAt) && Number.isFinite(s.refreshExpiresAt) ? s : null
}

async function sessionFor(account: ToadditAccount, fresh = false): Promise<ToadditSession> {
  const key = `toaddit.session.${toadditAccountId(account)}`
  const pending = globals.__toadditSessions!.get(key)
  if (pending) return pending
  const promise = (async () => {
    const row = await prisma.appSetting.findUnique({ where: { key } })
    let cached: ToadditSession | null = null
    try { cached = parseSession(JSON.parse(row?.value ?? 'null')) } catch {}
    if (!fresh && cached && cached.accessExpiresAt > Date.now() + 120_000) return cached
    let answer: any
    if (!fresh && cached && cached.refreshExpiresAt > Date.now() + 120_000) {
      try { answer = await request(account, '/app/refreshToken', { appKey: account.appKey, appSecret: account.appSecret, refreshToken: cached.refreshToken }) }
      catch (e) { if (!(e instanceof ToadditError) || ![130100, 130101, 130102, 130106].includes(e.code ?? -1)) throw e }
    }
    answer ??= await request(account, '/app/token', { appKey: account.appKey, appSecret: account.appSecret })
    const data = answer.data
    const accessSeconds = toadditNumber(data?.accessTokenExpiresIn)
    const refreshSeconds = toadditNumber(data?.refreshTokenExpiresIn)
    if (!str(data?.accessToken) || !str(data?.refreshToken) || !accessSeconds || accessSeconds <= 0 || !refreshSeconds || refreshSeconds <= 0) throw new ToadditError('Toaddit trả phiên đăng nhập không hợp lệ', 502)
    const session: ToadditSession = { accessToken: data.accessToken, refreshToken: data.refreshToken, accessExpiresAt: Date.now() + accessSeconds * 1000, refreshExpiresAt: Date.now() + refreshSeconds * 1000 }
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(session) }, update: { value: JSON.stringify(session) } })
    return session
  })()
  globals.__toadditSessions!.set(key, promise)
  try { return await promise } finally { globals.__toadditSessions!.delete(key) }
}

export async function callToaddit(account: ToadditAccount, path: string, body: unknown, mutation = false): Promise<any> {
  const session = await sessionFor(account)
  try { return await request(account, path, body, session, mutation) }
  catch (e) {
    // Read-only operations may renew an explicitly rejected token. Mutations are never replayed here.
    if (!mutation && e instanceof ToadditError && [401, 403].includes(e.status)) return request(account, path, body, await sessionFor(account, true))
    throw e
  }
}

async function pages(account: ToadditAccount, path: string, filter: object = {}): Promise<any[]> {
  const out: any[] = []
  for (let pageIndex = 1; pageIndex <= 100; pageIndex++) {
    const result = await callToaddit(account, path, { ...filter, page: { pageIndex, pageSize: 100 } })
    if (!Array.isArray(result.data)) throw new ToadditError('Toaddit trả danh sách không hợp lệ', 502)
    const current = toadditNumber(result.page?.pageIndex)
    if (current !== null && current !== pageIndex) throw new ToadditError('Toaddit trả sai số trang — dừng để tránh lặp dữ liệu', 502)
    out.push(...result.data)
    const total = toadditNumber(result.page?.total)
    if (total !== null && out.length >= total) return out
    if (result.data.length < 100) {
      if (total !== null && out.length < total) throw new ToadditError('Toaddit trả danh sách chưa đủ số lượng', 502)
      return out
    }
  }
  throw new ToadditError('Danh sách Toaddit quá lớn — chưa đọc hết, không dùng kết quả một phần', 502)
}

function safeImage(value: unknown): string | null {
  if (!str(value)) return null
  try { return assertSafeExternalUrl(String(value)).href } catch { return null }
}

export async function listToadditTemplates(account: ToadditAccount, customSku?: string): Promise<ToadditTemplate[]> {
  const templates: ToadditTemplate[] = []
  for (const collection of await pages(account, '/productService/productCollectionList', customSku ? { customSku } : {})) {
    const prototype = collection.productPrototype
    if (!Array.isArray(collection.customProductList) || !Array.isArray(prototype?.styleList) || !Array.isArray(prototype?.sizeList)) throw new ToadditError('Mẫu Toaddit thiếu danh sách style/size', 502)
    for (const product of collection.customProductList) {
      if (!Array.isArray(product.customSpecificProductList)) throw new ToadditError('Mẫu Toaddit thiếu danh sách SKU', 502)
      const style = prototype.styleList.find((s: any) => toadditId(s.id) === toadditId(product.styleId))
      const images = (Array.isArray(product.customShowImageList) ? product.customShowImageList : []).map((m: any) => safeImage(m.clearPath) ?? safeImage(m.showImagePath)).filter((u: string | null): u is string => !!u)
      for (const v of product.customSpecificProductList) {
        const id = toadditId(v.id)
        const collectionId = toadditId(collection.id)
        const sku = str(v.customSku) ?? str(v.sku)
        const size = prototype.sizeList.find((s: any) => toadditId(s.id) === toadditId(v.sizeId))
        if (!id || !collectionId || !sku) throw new ToadditError('Toaddit có ID/SKU mẫu không hợp lệ', 502)
        templates.push({ id, collectionId, sku, name: str(collection.englishName) ?? str(prototype.englishName) ?? sku,
          size: str(size?.sizeName) ?? '', style: str(style?.name) ?? '', active: Number(collection.referChange) === 0 && Number(style?.status) === 1 && Number(size?.status) === 1,
          baseCost: toadditNumber(size?.lowerLimitPrice), images,
          revision: JSON.stringify([collection.createTime, product.createTime, v.createTime, collection.referChange, product.styleId, v.sizeId]),
        })
      }
    }
  }
  if (new Set(templates.map(t => t.id)).size !== templates.length) throw new ToadditError('Toaddit trả ID mẫu trùng — không tự chọn', 502)
  return templates
}

export function toadditOrderOf(raw: any): ToadditOrder | null {
  const id = toadditId(raw?.id ?? raw?.orderId)
  const code = str(raw?.orderCode)
  if (!id || !code) return null
  const finance = raw.orderFinance
  const product = toadditNumber(finance?.paymentProductAmount)
  const freight = toadditNumber(finance?.finalFreightAmount ?? finance?.paymentFreightAmount)
  const tax = toadditNumber(finance?.paymentTax)
  return { id, code, externalOrderCode: str(raw.externalOrderCode), status: toadditNumber(raw.status), wholesale: Number(raw.isWholesale) === 1, freight,
    total: product !== null && freight !== null ? Math.round((product + freight + (tax ?? 0)) * 100) / 100 : null, raw }
}

export async function findToadditOrder(account: ToadditAccount, externalOrderCode: string): Promise<ToadditOrder | null> {
  const rows = (await pages(account, '/order/list', { externalOrderCode, isReturnItems: 1, isReturnLogistics: 1, isReturnFinance: 1 })).filter(r => r.externalOrderCode === externalOrderCode)
  if (rows.length > 1) throw new ToadditError('Toaddit có nhiều đơn cùng mã ngoài — cần đối chiếu thủ công', 409)
  const order = rows.length ? toadditOrderOf(rows[0]) : null
  if (rows.length && !order) throw new ToadditError('Toaddit trả thông tin đơn không hợp lệ', 502)
  return order
}

export async function createToadditOrder(account: ToadditAccount, rawBody: string): Promise<ToadditOrder> {
  const payload = JSON.parse(rawBody) as ToadditOrderPayload
  const result = await callToaddit(account, '/order/create', payload, true)
  const payment = toadditNumber(result.data?.paymentResult)
  const remote = toadditOrderOf({ ...result.data, externalOrderCode: payload.externalOrderCode, status: payment === 1 ? 41 : payment === 0 ? 30 : null })
  if (!remote) throw new ToadditError('Toaddit nhận yêu cầu nhưng không trả mã đơn — cần đối chiếu trước khi gửi lại', 502, null, true)
  return remote
}

export async function cancelToadditOrder(account: ToadditAccount, id: string): Promise<void> {
  const answer = await callToaddit(account, '/order/cancel', { id }, true)
  if (toadditId(answer.data?.id) !== id || Number(answer.data?.newStatus) !== 80) throw new ToadditError('Toaddit chưa xác nhận huỷ đơn — giữ trạng thái đã gửi', 409, null, true)
}

export function toadditStatus(order: ToadditOrder): string | null {
  const labels: Record<number, string> = { 11: 'Chưa ghép mẫu', 30: 'Chưa thanh toán', 31: 'Chưa thanh toán', 40: 'Chờ sản xuất', 41: 'Chờ sản xuất', 42: 'Đang sản xuất', 70: 'Đã gửi hàng', 71: 'Khiếu nại', 79: 'Đã xử lý khiếu nại', 80: 'Đã huỷ', 90: 'Hoàn thành' }
  return `${order.status === null ? 'Chưa rõ trạng thái' : labels[order.status] ?? order.status}${order.wholesale ? ' · Wholesale — xử lý trên Toaddit' : ''}`
}

export function toadditTracking(rows: any[], order: ToadditOrder, quantity: number): { number: string; company: string | null } | null {
  if (![70, 90].includes(order.status ?? -1) || rows.length !== 1) return null
  const row = rows[0]
  if (toadditId(row.orderId) !== order.id || Number(row.productCount) !== quantity || ![70, 90].includes(Number(row.orderStatus))) return null
  if (![4, 5, 6].includes(Number(row.waybillStatus)) || (str(row.shippingMethodName) ?? '').toLowerCase() === 'toaddit') return null
  const number = str(row.waybillCode)
  return number ? { number, company: str(row.companyName) } : null
}

export async function getToadditTracking(account: ToadditAccount, id: string): Promise<any[]> {
  const result = await callToaddit(account, '/orderLogistics/trackInfo', { id })
  if (!Array.isArray(result.data)) throw new ToadditError('Toaddit trả tracking không hợp lệ', 502)
  return result.data
}
