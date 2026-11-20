import { assertSafeExternalUrl } from '@/lib/safe-url'
import { sameLabel } from '@/lib/task-files'

const BASE_URL = 'https://seller-v8.lenful.com/api/public/v1'
const HOST = 'seller-v8.lenful.com'
const DEFAULT_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = 60_000
const PAGE_LIMIT = 100

export const LENFUL_SUPPLIER_KEY = 'lenful'

export function isLenfulSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === LENFUL_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === LENFUL_SUPPLIER_KEY
}

export class LenfulError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
    // No clear answer came back (timeout, network, 5xx, unreadable body): the request may still have been processed.
    readonly unknownOutcome = false,
  ) {
    super(message)
    this.name = 'LenfulError'
  }
}

export type LenfulAddress = {
  name: string; line1: string; line2?: string | null; city: string; state_code?: string | null
  postal?: string | null; country_code: string; phone?: string | null
}
export type LenfulDesign = { position: string; design_url: string }
export type LenfulLineItem = { sku: string; quantity: number; designs?: LenfulDesign[]; mockup_urls?: string[] }
export type LenfulOrderPayload = {
  external_order_id: string; store_id?: string; shipping_method_code?: number
  shipping_address: LenfulAddress; line_items: LenfulLineItem[]
}

export type LenfulPosition = { code: string; label: string | null; isPrimary: boolean }
export type LenfulProduct = { id: string; name: string | null; type: string | null; positions: LenfulPosition[] }
export type LenfulVariant = { id: string | null; sku: string; listPrice: number | null; attributes: Record<string, string> }
export type LenfulCatalogHit = { product: LenfulProduct; variant: LenfulVariant }
export type LenfulItem = { id: string; sku: string | null; quantity: number | null; status: string | null; revenue: number | null; designSku: string | null }
export type LenfulOrder = {
  id: string; code: string | null; externalOrderId: string | null; status: string | null; paymentStatus: string | null
  total: number | null; createdAt: string | null; items: LenfulItem[]
}
export type LenfulTracking = { itemId: string | null; carrier: string | null; number: string; status: string | null; current: boolean }
export type LenfulStore = { id: string; name: string | null; platform: string | null; isDefault: boolean; status: string | null }

const STATUS_LABELS: Record<string, string> = {
  pending: 'Chờ xử lý', picked: 'Đã nhận đơn', processing: 'Đang sản xuất', fulfillment: 'Đã giao vận chuyển',
  updating: 'Đang sửa đơn', hold: 'Tạm giữ', resend: 'Gửi lại', cancel: 'Đã huỷ',
}

export const LENFUL_UNPAID_LABEL = 'Chưa thanh toán'

/** "Đang sản xuất", with "· Chưa thanh toán" while Lenful still waits for the wallet. */
export function remoteStatusOf(o: Pick<LenfulOrder, 'status' | 'paymentStatus'>): string | null {
  const status = o.status ? STATUS_LABELS[o.status] ?? o.status : null
  const unpaid = o.paymentStatus === 'unpaid' ? LENFUL_UNPAID_LABEL : null
  return [status, unpaid].filter(Boolean).join(' · ') || null
}

export const isCancelled = (o: Pick<LenfulOrder, 'status'>) => o.status === 'cancel'

/** A number is read once the order left "pending": Lenful hands it out in production, and a cancelled order's must not reach the shopper. */
export const mayCarryTracking = (o: Pick<LenfulOrder, 'status'>) => !isCancelled(o) && o.status !== 'pending'

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Lenful counts money in US cents. */
export const dollars = (cents: unknown): number | null => {
  const n = num(cents)
  return n === null ? null : Math.round(n) / 100
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])

async function exchange(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string; json: any; headers: Headers | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  let headers: Headers | null = null
  try {
    const res = await fetch(assertSafeExternalUrl(url, { allowedHosts: [HOST] }), { ...init, signal: controller.signal, cache: 'no-store', redirect: 'error' })
    status = res.status
    headers = res.headers
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new LenfulError(
      timedOut ? `Lenful không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được Lenful: ${e?.message ?? e}`,
      0, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status, text, json, headers }
}

/** `data.errors[]` of a 422 lists every problem as { field, message }; a 401 comes as the framework's own {statusCode, message}. */
function refusalMessage(status: number, json: any, text: string, headers: Headers | null): string {
  const said = str(json?.message)
  const errors = list(json?.data?.errors ?? json?.errors)
    .map(e => [str(e?.field), str(e?.message)].filter(Boolean).join(': '))
    .filter(Boolean)
  if (status === 401) return `Lenful không nhận API key (${said ?? 'HTTP 401'}) — tạo key mới ở Lenful Settings › API keys`
  if (status === 429) return `Lenful đang giới hạn số lần gọi — thử lại sau ${headers?.get('retry-after') ?? '60'} giây`
  if (errors.length > 0) return `${said ? `${said}: ` : ''}${errors.join('; ')}`
  if (said) return said
  return text.trim() && !text.trim().startsWith('<') ? text.trim().slice(0, 500) : `Lenful trả về HTTP ${status}`
}

type RequestOptions = { query?: Record<string, string>; body?: string; timeoutMs?: number }

type Answer = { status: number; data: any; message: string | null }

/** Every answer is { success, message, data }. A 409 is handed back to the caller: on a create it carries the order already made. */
async function request(method: 'GET' | 'POST', path: string, apiKey: string, opts: RequestOptions = {}): Promise<Answer> {
  const q = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
  const { status, text, json, headers } = await exchange(`${BASE_URL}${path}${q}`, {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body,
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const detail = json ?? text.slice(0, 2000)
  if (status >= 500) throw new LenfulError(refusalMessage(status, json, text, headers), status, detail, true)
  if (status === 409) return { status, data: json?.data ?? null, message: str(json?.message) }
  if (status < 200 || status >= 300) throw new LenfulError(refusalMessage(status, json, text, headers), status, detail)
  if (!json || typeof json !== 'object' || json.success === false) {
    throw new LenfulError(str(json?.message) ?? 'Lenful trả về dữ liệu không đọc được', status, detail, !json)
  }
  return { status, data: json.data, message: str(json.message) }
}

async function read(path: string, apiKey: string, opts: RequestOptions = {}): Promise<any> {
  const a = await request('GET', path, apiKey, opts)
  if (a.status === 409) throw new LenfulError(a.message ?? 'Lenful trả về HTTP 409', 409, a.data)
  return a.data
}

export function orderOf(o: any): LenfulOrder | null {
  const id = str(o?.id)
  if (!id) return null
  return {
    id, code: str(o?.code), externalOrderId: str(o?.external_order_id), status: str(o?.workflow_status), paymentStatus: str(o?.payment_status),
    total: dollars(o?.revenue_total), createdAt: str(o?.created_at),
    items: list(o?.items).flatMap(i => {
      const itemId = str(i?.id)
      return itemId ? [{ id: itemId, sku: str(i?.sku), quantity: num(i?.quantity), status: str(i?.workflow_status), revenue: dollars(i?.item_revenue), designSku: str(i?.design_sku) }] : []
    }),
  }
}

export async function listStores(apiKey: string): Promise<LenfulStore[]> {
  const data = await read('/stores', apiKey)
  return list(data?.items).flatMap(s => {
    const id = str(s?.id)
    return id ? [{ id, name: str(s?.name), platform: str(s?.platform), isDefault: s?.is_default === true, status: str(s?.status) }] : []
  })
}

export async function getWallet(apiKey: string): Promise<{ balance: number | null; currency: string | null }> {
  const data = await read('/wallet', apiKey)
  return { balance: dollars(data?.balance), currency: str(data?.currency) }
}

function productOf(p: any): LenfulProduct | null {
  const id = str(p?.id)
  if (!id) return null
  const positions = list(p?.print_positions).flatMap(x => {
    const code = str(x?.code)
    return code ? [{ code, label: str(x?.label), isPrimary: x?.is_primary === true }] : []
  })
  return { id, name: str(p?.name), type: str(p?.type), positions }
}

/** Products whose name or a variant SKU holds `q`. The POST list is read-only and counts as a read. */
export async function searchProducts(apiKey: string, q: string, page = 1): Promise<{ products: LenfulProduct[]; total: number | null }> {
  const a = await request('POST', '/products/list', apiKey, { query: { page: String(page), limit: String(PAGE_LIMIT) }, body: JSON.stringify({ q }) })
  if (a.status === 409) throw new LenfulError(a.message ?? 'Lenful trả về HTTP 409', 409, a.data)
  return { products: list(a.data?.items).map(productOf).filter((p): p is LenfulProduct => !!p), total: num(a.data?.total) }
}

export async function listVariants(apiKey: string, productId: string): Promise<LenfulVariant[]> {
  const data = await read(`/products/${encodeURIComponent(productId)}/variants`, apiKey)
  return list(data?.items).flatMap(v => {
    const sku = str(v?.sku)
    if (!sku) return []
    const attributes: Record<string, string> = {}
    for (const [k, val] of Object.entries(v?.attributes && typeof v.attributes === 'object' ? v.attributes : {})) {
      const s = str(val)
      if (s) attributes[k] = s
    }
    return [{ id: str(v?.id), sku, listPrice: dollars(v?.list_price), attributes }]
  })
}

/** The catalog product and variant of one Lenful SKU, matched exactly (the search is a substring one). */
export async function findVariant(apiKey: string, sku: string): Promise<LenfulCatalogHit | null> {
  const { products } = await searchProducts(apiKey, sku)
  for (const product of products) {
    const variant = (await listVariants(apiKey, product.id)).find(v => v.sku === sku)
    if (variant) return { product, variant }
  }
  return null
}

export type CreateResult = { order: LenfulOrder | null; duplicate: boolean; message: string | null }

/**
 * Sends the exact reviewed body. A 409 means Lenful already holds this number in that store and hands that order back, or
 * an identical request is still being processed (no order in the answer yet).
 */
export async function createOrder(apiKey: string, rawBody: string): Promise<CreateResult> {
  const a = await request('POST', '/orders', apiKey, { body: rawBody, timeoutMs: CREATE_TIMEOUT_MS })
  return { order: orderOf(a.data), duplicate: a.status === 409, message: a.message }
}

export async function getOrder(apiKey: string, id: string): Promise<LenfulOrder | null> {
  try {
    return orderOf(await read(`/orders/${encodeURIComponent(id)}`, apiKey))
  } catch (e) {
    if (e instanceof LenfulError && e.status === 404) return null
    throw e
  }
}

/** The day in Vietnam time (UTC+7), which is how the order list filters by date. */
export function vietnamDay(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10)
}

/**
 * The order under our number, a live one before a cancelled one. The list has no filter for it, so the orders made since
 * the day before the push are read, newest first, at most `maxPages` pages of 100.
 */
export async function findOrderByExternalId(
  apiKey: string, externalOrderId: string, ctx: { since: Date; storeId?: string | null; maxPages?: number },
): Promise<LenfulOrder | null> {
  const from = vietnamDay(new Date(ctx.since.getTime() - 24 * 3600_000))
  const hits: LenfulOrder[] = []
  for (let page = 1; page <= (ctx.maxPages ?? 5); page++) {
    const data = await read('/orders', apiKey, {
      query: { page: String(page), limit: String(PAGE_LIMIT), created_from: from, ...(ctx.storeId ? { store_id: ctx.storeId } : {}) },
    })
    const rows = list(data?.items)
    for (const r of rows) {
      const o = orderOf(r)
      if (o && o.externalOrderId === externalOrderId) hits.push(o)
    }
    const totalPages = num(data?.totalPages)
    if (rows.length < PAGE_LIMIT || (totalPages !== null && page >= totalPages)) break
  }
  return hits.find(o => !isCancelled(o)) ?? hits[0] ?? null
}

/** Cancels every item still pending and refunds it to the wallet; items in production stay. Needs the key scope orders:cancel. */
export async function cancelOrder(apiKey: string, id: string, reason: string): Promise<{ order: LenfulOrder | null; message: string | null; refused: boolean }> {
  const a = await request('POST', `/orders/${encodeURIComponent(id)}/cancel`, apiKey, { body: JSON.stringify({ reason }) })
  return { order: orderOf(a.data), message: a.message, refused: a.status === 409 }
}

export async function getTrackings(apiKey: string, id: string): Promise<LenfulTracking[]> {
  const data = await read(`/orders/${encodeURIComponent(id)}/trackings`, apiKey)
  return list(data?.items).flatMap(t => {
    const number = str(t?.tracking_number)
    return number ? [{ itemId: str(t?.order_item_id), carrier: str(t?.carrier), number, status: str(t?.status), current: t?.is_current !== false }] : []
  })
}

/** The current number of each Lenful item. An item that lists several current numbers is left out: a wrong tracking is worse than none. */
export function currentTrackingByItem(rows: LenfulTracking[]): Map<string, LenfulTracking> {
  const byItem = new Map<string, LenfulTracking[]>()
  for (const r of rows) {
    if (!r.itemId || !r.current) continue
    byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r])
  }
  const out = new Map<string, LenfulTracking>()
  byItem.forEach((rs, itemId) => { if (new Set(rs.map(r => r.number)).size === 1) out.set(itemId, rs[0]) })
  return out
}

export type DesignPlan = { designs: LenfulDesign[]; unmatched: string[]; missingPrimary: string | null }

/**
 * Our print parts as Lenful print positions, the primary one first (Lenful prices every position after the first as an extra
 * print area). A product with one position takes our one file there; otherwise parts match positions by code or label.
 */
export function designsFor(prints: { area: string; publicUrl: string | null }[], positions: LenfulPosition[]): DesignPlan {
  const url = (p: { publicUrl: string | null }) => p.publicUrl ?? ''
  const primary = positions.find(p => p.isPrimary) ?? null
  if (positions.length === 1 && prints.length === 1) {
    return { designs: [{ position: positions[0].code, design_url: url(prints[0]) }], unmatched: [], missingPrimary: null }
  }
  const designs: LenfulDesign[] = []
  const unmatched: string[] = []
  for (const p of prints) {
    const pos = positions.find(x => sameLabel(x.code, p.area) || (!!x.label && sameLabel(x.label, p.area)))
    if (!pos || designs.some(d => d.position === pos.code)) { unmatched.push(p.area); continue }
    designs.push({ position: pos.code, design_url: url(p) })
  }
  if (primary) designs.sort((a, b) => Number(b.position === primary.code) - Number(a.position === primary.code))
  const missingPrimary = primary && designs.length > 0 && !designs.some(d => d.position === primary.code) ? primary.label ?? primary.code : null
  return { designs, unmatched, missingPrimary }
}

/** A shipping method code: a whole number from Lenful's Orders › Import list. */
export function methodCodeOf(value: string | null | undefined): number | null {
  const v = (value ?? '').trim()
  return /^\d{1,6}$/.test(v) ? Number(v) : null
}
