import { assertSafeExternalUrl } from '@/lib/safe-url'
import type { SkuOption } from '@/lib/supplier-sku-suggest'

const BONDRE_BASE_URL = 'https://bondre.vip/api/open/v1'
const BONDRE_HOST = 'bondre.vip'
const DEFAULT_TIMEOUT_MS = 30_000
// A create also runs the sync inside the call; nginx drops a request silent for 60s, so give up before that.
const CREATE_TIMEOUT_MS = 45_000
const SKU_PAGE_SIZE = 100
const SKU_MAX_PAGES = 50

export const BONDRE_SUPPLIER_KEY = 'bondre'

export function isBondreSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === BONDRE_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === BONDRE_SUPPLIER_KEY
}

export class BondreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
    // True when no HTTP answer came back (timeout, network): the request may still have been processed.
    readonly noResponse = false,
  ) {
    super(message)
    this.name = 'BondreError'
  }
}

/** Where the token comes from: the API has no key, only a login that gives a token lasting 1 to 90 days. */
export type BondreSession = { token: () => Promise<string>; renew: () => Promise<string> }

export type BondreOrderItem = {
  skuName: string; quantity: number
  design1: string; design2?: string; design3?: string; design4?: string
  mockup1: string
}

export type BondreOrderPackage = {
  recipientName: string; phoneNumber?: string; streetAddress: string; city: string; stateCode?: string
  postcode: string; countryCode: string; expressShippingType: number
  items: BondreOrderItem[]
}

export type BondreOrderPayload = {
  merchantOrderCode: string
  orderType: 'Official Order'
  autoSync: true
  packages: BondreOrderPackage[]
}

export type BondrePackage = { tracking: string | null; skuNames: string[]; status: string | null }

export type BondreRemoteOrder = {
  orderId: number; orderCode: string | null; status: string | null
  /** The system orders of a split customer order; a cancel has to reach each of them. */
  memberOrderIds: number[]
  packages: BondrePackage[]
}

export type BondreCreateResult = {
  previewId: number | null
  syncStatus: 'SYNCED' | 'FAILED' | 'UNKNOWN' | null
  orderCode: string | null
  orderCodes: string[]
  syncError: string | null
  raw: unknown
}

const SHIPPING_TYPES = [
  { type: 1, name: 'Standard' },
  { type: 2, name: 'Fast' },
  { type: 3, name: 'Express' },
  { type: 4, name: 'USPS' },
]

/** A SKU's ship setting by name or number; empty means Standard, and null means Bondre has no such method. */
export function shippingTypeOf(value: string | null | undefined): { type: number; name: string } | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return SHIPPING_TYPES[0]
  return SHIPPING_TYPES.find(s => s.name.toLowerCase() === v || String(s.type) === v) ?? null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function messages(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map(m => str(m) ?? str((m as any)?.message) ?? str((m as any)?.msg)).filter((m): m is string => !!m)
}

function errorMessage(json: any, text: string, status: number): string {
  return str(json?.msg) ?? str(json?.message) ?? (text.trim() && !text.trim().startsWith('<') ? text.trim().slice(0, 500) : `Bondre trả về HTTP ${status}`)
}

type RequestOptions = { body?: string; headers?: Record<string, string>; token?: string | null; timeoutMs?: number }

async function request(method: 'GET' | 'POST', path: string, opts: RequestOptions): Promise<any> {
  const url = assertSafeExternalUrl(`${BONDRE_BASE_URL}${path}`, { allowedHosts: [BONDRE_HOST] })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    status = res.status
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new BondreError(
      timedOut ? `Bondre không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được Bondre: ${e?.message ?? e}`,
      0, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  // HTTP 200 alone is not success: the envelope carries its own code.
  if (status < 200 || status >= 300 || (json && json.code !== undefined && json.code !== 200)) {
    throw new BondreError(errorMessage(json, text, status), status, json ?? text.slice(0, 2000))
  }
  if (json === null) throw new BondreError('Bondre trả về dữ liệu không phải JSON', status, text.slice(0, 2000))
  return json.data
}

/** A 401 only means an expired token and nothing was processed, so one retry with a new token is safe even for a create. */
async function call(session: BondreSession, method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<any> {
  try {
    return await request(method, path, { ...opts, token: await session.token() })
  } catch (e) {
    if (!(e instanceof BondreError) || e.status !== 401) throw e
    return request(method, path, { ...opts, token: await session.renew() })
  }
}

export async function issueToken(email: string, password: string): Promise<{ token: string; expireTime: string | null }> {
  const data = await request('POST', '/auth/token', { body: JSON.stringify({ email, password }) })
  const token = str(data?.token)
  if (!token) throw new BondreError('Bondre không trả về token', 200, null)
  return { token, expireTime: str(data?.expireTime) }
}

export async function getAccount(session: BondreSession): Promise<{ businessName: string | null; balance: number | null; availableAmount: number | null }> {
  const d = await call(session, 'GET', '/account')
  return {
    businessName: str(d?.businessName),
    balance: typeof d?.balance === 'number' ? d.balance : null,
    availableAmount: typeof d?.availableAmount === 'number' ? d.availableAmount : null,
  }
}

export async function listAllSkus(session: BondreSession): Promise<SkuOption[]> {
  const out: SkuOption[] = []
  for (let page = 1; page <= SKU_MAX_PAGES; page++) {
    const q = new URLSearchParams({ pageNum: String(page), pageSize: String(SKU_PAGE_SIZE) })
    const data = await call(session, 'GET', `/skus?${q}`)
    const rows: any[] = Array.isArray(data?.rows) ? data.rows : []
    for (const r of rows) {
      const skuName = str(r?.skuName)
      if (skuName) out.push({ skuName, skuCode: str(r?.skuCode), productName: str(r?.productName) })
    }
    if (rows.length < SKU_PAGE_SIZE) break
  }
  return out
}

/** Creates nothing: no order, no reservation, no order number taken. */
export async function quoteOrder(session: BondreSession, rawBody: string): Promise<{ warnings: string[]; errors: string[]; raw: unknown }> {
  const data = await call(session, 'POST', '/orders/quote', { body: rawBody })
  return { warnings: messages(data?.warnings), errors: messages(data?.errors), raw: data }
}

function createResult(data: any, raw: unknown): BondreCreateResult {
  const syncStatus = data?.syncStatus === 'SYNCED' || data?.syncStatus === 'FAILED' || data?.syncStatus === 'UNKNOWN' ? data.syncStatus : null
  return {
    previewId: posInt(data?.previewId),
    syncStatus,
    orderCode: str(data?.orderCode),
    orderCodes: Array.isArray(data?.orderCodes) ? data.orderCodes.filter((c: unknown) => !!str(c)) : [],
    syncError: str(data?.syncError),
    raw,
  }
}

/** Never retried by us: pass the exact reviewed body. A failed or unknown sync comes back as a result, because a Preview may exist on Bondre. */
export async function createOrder(session: BondreSession, rawBody: string): Promise<BondreCreateResult> {
  try {
    const data = await call(session, 'POST', '/orders', { body: rawBody, timeoutMs: CREATE_TIMEOUT_MS })
    return createResult(data, data)
  } catch (e) {
    const body = e instanceof BondreError ? (e.body as any) : null
    const data = body?.data ?? body
    if (data?.syncStatus) return createResult({ ...data, syncError: data.syncError ?? (e as BondreError).message }, body)
    throw e
  }
}

/** The formal order under a customer order number, with its packages; null while only a Preview exists. */
export async function findOrder(session: BondreSession, merchantOrderCode: string): Promise<BondreRemoteOrder | null> {
  const q = new URLSearchParams({ merchantOrderCode, pageNum: '1', pageSize: '20' })
  const list = await call(session, 'GET', `/orders?${q}`)
  const rows: any[] = Array.isArray(list?.rows) ? list.rows : []
  const row = rows.find(r => r?.merchantOrderCode === undefined || r?.merchantOrderCode === merchantOrderCode)
  const orderId = posInt(row?.orderId)
  if (!orderId) return null
  const d = await call(session, 'GET', `/orders/${orderId}`)
  const packages: any[] = Array.isArray(d?.packages) ? d.packages : []
  return {
    orderId,
    orderCode: str(d?.orderCode) ?? str(row?.orderCode),
    status: str(d?.status) ?? str(row?.status),
    memberOrderIds: Array.isArray(d?.memberOrderIds) ? d.memberOrderIds.filter((id: unknown) => !!posInt(id)) : [],
    packages: packages.map(p => ({
      tracking: str(p?.trackingNo) ?? str(p?.localTrackingNo),
      skuNames: (Array.isArray(p?.orderItems) ? p.orderItems : []).map((i: any) => str(i?.skuName)).filter((s: string | null): s is string => !!s),
      status: str(p?.packageStatus),
    })),
  }
}

export async function cancelOrder(session: BondreSession, orderId: number, idempotencyKey: string): Promise<void> {
  await call(session, 'POST', `/orders/${orderId}/cancel`, { headers: { 'Idempotency-Key': idempotencyKey } })
}

/** A pending Preview under a customer order number: what a failed sync leaves behind. */
export async function findPendingPreview(session: BondreSession, merchantOrderCode: string): Promise<{ previewId: number; syncError: string | null } | null> {
  const q = new URLSearchParams({ keyword: merchantOrderCode, pageNum: '1', pageSize: '100' })
  const data = await call(session, 'GET', `/order-previews?${q}`)
  const rows: any[] = Array.isArray(data?.rows) ? data.rows : []
  const row = rows.find(r => r?.merchantOrderCode === merchantOrderCode)
  const previewId = posInt(row?.previewId)
  return previewId ? { previewId, syncError: str(row?.syncError) } : null
}

export async function deletePreview(session: BondreSession, previewId: number): Promise<void> {
  const data = await call(session, 'POST', '/order-previews/delete', { body: JSON.stringify({ previewIds: [previewId] }) })
  const result = Array.isArray(data?.results) ? data.results[0] : null
  if (result?.success === false) throw new BondreError(str(result?.message) ?? 'Bondre không xoá được Preview', 200, data)
}

/** The package of a line. A split order must name the SKU: a wrong tracking on a shopper's order is worse than none. */
export function packageForLine(skuName: string | null | undefined, packages: BondrePackage[]): BondrePackage | null {
  if (packages.length === 1) return packages[0]
  return (skuName ? packages.find(p => p.skuNames.includes(skuName)) : null) ?? null
}
