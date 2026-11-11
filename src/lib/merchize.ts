import { assertSafeExternalUrl } from '@/lib/safe-url'
import { getStoreSettings } from '@/lib/store-settings'

const DEFAULT_TIMEOUT_MS = 30_000
const MERCHIZE_HOST = 'merchize.com'

export const MERCHIZE_SUPPLIER_KEY = 'merchize'
export type MerchizePrintingMethod = 'DTF' | 'DTG'

export type MerchizeCredentials = { baseUrl: string; token: string }

export class MerchizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
    // True when no HTTP answer came back (timeout, network): the request may still have been processed.
    readonly noResponse = false,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'MerchizeError'
  }
}

function normalizedCredentials(apiUrl: string | null | undefined, token: string | null | undefined): MerchizeCredentials | null {
  const baseUrl = apiUrl?.trim().replace(/\/+$/, '')
  const key = token?.trim()
  return baseUrl && key ? { baseUrl, token: key } : null
}

/** The bo-api base URL and token of the server's own Merchize account live in the server env. */
export function serverMerchizeCredentials(): MerchizeCredentials | null {
  return normalizedCredentials(process.env.MERCHIZE_API_URL, process.env.MERCHIZE_API_TOKEN)
}

export type MerchizeResolution =
  | { creds: MerchizeCredentials; source: 'store' | 'server' }
  | { creds: null; missing: 'url' | 'token' | 'both' }

/**
 * The Merchize account a store sends under: its own URL and token when it has saved either, otherwise the server's.
 * A store with only one of the two has half an account and gets none (`missing` says which half): it never falls
 * back to the server's account, which would be another account's money. Without a `storeId` this is the server's account.
 */
export async function resolveMerchize(storeId?: string): Promise<MerchizeResolution> {
  if (storeId) {
    const own = await getStoreSettings(storeId, ['merchize.apiUrl', 'merchize.token'])
    if (own['merchize.apiUrl'] || own['merchize.token']) {
      const creds = normalizedCredentials(own['merchize.apiUrl'], own['merchize.token'])
      return creds ? { creds, source: 'store' } : { creds: null, missing: own['merchize.apiUrl'] ? 'token' : 'url' }
    }
  }
  const creds = serverMerchizeCredentials()
  return creds ? { creds, source: 'server' } : { creds: null, missing: 'both' }
}

export async function merchizeCredentials(storeId?: string): Promise<MerchizeCredentials | null> {
  return (await resolveMerchize(storeId)).creds
}

/** Why a store cannot send to Merchize: half an account of its own, or no account at all (its own or the server's). */
export function merchizeMissingMessage(storeName: string, missing: 'url' | 'token' | 'both'): string {
  const where = `Super Admin sửa ở Setup, mục "Các store đang kết nối", dòng ${storeName}`
  if (missing === 'token') return `Store ${storeName} mới có URL API Merchize, chưa có token. Nhập thêm token, hoặc xoá URL để dùng khoá của server. ${where}`
  if (missing === 'url') return `Store ${storeName} mới có token Merchize, chưa có URL API. Nhập thêm URL, hoặc xoá token để dùng khoá của server. ${where}`
  return `Store ${storeName} chưa có khoá API Merchize riêng và server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN. ${where}`
}

export function merchizePrintingMethod(): MerchizePrintingMethod {
  return process.env.MERCHIZE_PRINTING_METHOD?.trim().toUpperCase() === 'DTG' ? 'DTG' : 'DTF'
}

export function isMerchizeSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === MERCHIZE_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === MERCHIZE_SUPPLIER_KEY
}

export type MerchizeShippingInfo = {
  full_name: string; address_1: string; address_2: string; city: string; state: string
  postcode: string; country: string; email: string; phone: string
}

export type MerchizeOrderItem = {
  name: string; sku: string; merchize_sku: string; product_id: string; quantity: number; price: number; currency: string
  /** Left out for a product whose catalog entry lists no printing method (AOP, acrylic, wood): Merchize rejects DTF/DTG there. */
  printing_method?: MerchizePrintingMethod; image: string
  design_front?: string; design_back?: string; design_sleeve?: string; design_hood?: string
  attributes: { name: string; option: string }[]
}

export type MerchizeOrderPayload = {
  order_id: string
  identifier: string
  shipping_info: MerchizeShippingInfo
  items: MerchizeOrderItem[]
}

export type MerchizeCatalogVariant = {
  _id: string; sku: string
  attributes: { name: string; type: string; value_text: string; value_code: string }[]
  shipping_prices: { to_zone: string; to_country: string; first_item_price: number | null; additional_item_price: number | null }[]
  tiers: { name: string; price: number | null }[]
}

export type MerchizeCatalogProduct = {
  _id: string; sku: string; title: string; printing_methods: string[]
  fulfillment_location: { name: string; code: string } | null
  mockup_and_templates_link: string | null
  production_time: { min: number; max: number } | null
  variants: MerchizeCatalogVariant[]
}

export type MerchizeRemoteOrder = {
  code: string | null; id: string | null; status: string | null
  fulfillmentCost: number | null; shippingCost: number | null
}

export type MerchizeTracking = {
  number: string; company: string | null; url: string | null
  items: { sku: string | null; catalogSku: string | null; quantity: number | null }[]
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function errorMessage(json: any, text: string, status: number): string {
  const fromJson = json && typeof json === 'object'
    ? str(json.message) ?? str(json.error) ?? (json.errors ? JSON.stringify(json.errors).slice(0, 500) : null)
    : null
  return fromJson ?? (text.trim() && !text.trim().startsWith('<') ? text.trim().slice(0, 500) : `Merchize trả về HTTP ${status}`)
}

async function call(creds: MerchizeCredentials, method: 'GET' | 'POST', path: string, rawBody?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const url = assertSafeExternalUrl(`${creds.baseUrl}${path}`, { allowedHosts: [MERCHIZE_HOST] })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  let retryAfterMs: number | undefined
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, ...(rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: rawBody,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    status = res.status
    const retryAfter = res.headers.get('Retry-After')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
      if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay)
    }
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new MerchizeError(
      timedOut ? `Merchize không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được Merchize: ${e?.message ?? e}`,
      0, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (status < 200 || status >= 300 || json?.success === false) {
    throw new MerchizeError(errorMessage(json, text, status), status, json ?? text.slice(0, 2000), false, retryAfterMs)
  }
  if (json === null) throw new MerchizeError('Merchize trả về dữ liệu không phải JSON', status, text.slice(0, 2000))
  return json
}

const readCooldown = new Map<string, number>()

async function read(creds: MerchizeCredentials, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const wait = (readCooldown.get(creds.baseUrl) ?? 0) - Date.now()
    if (wait > 60_000) throw new MerchizeError('Merchize đang giới hạn tần suất, thử lại ở lượt đồng bộ sau', 429, null, false, wait)
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    try {
      const result = await call(creds, 'GET', path)
      readCooldown.delete(creds.baseUrl)
      return result
    } catch (e) {
      if (!(e instanceof MerchizeError) || e.status !== 429) throw e
      const delay = e.retryAfterMs ?? 30_000 * (attempt + 1)
      readCooldown.set(creds.baseUrl, Date.now() + delay)
      if (attempt >= 2 || delay > 60_000) throw e
    }
  }
}

export async function searchCatalog(creds: MerchizeCredentials, skus: string[]): Promise<MerchizeCatalogProduct[]> {
  const q = new URLSearchParams({ limit: '50', page: '1', search: skus.join(',') })
  const json = await read(creds, `/product/catalog?${q}`)
  const products: any[] = Array.isArray(json?.data?.products) ? json.data.products : []
  return products as MerchizeCatalogProduct[]
}

export function serializeOrderPayload(payload: MerchizeOrderPayload): string {
  return JSON.stringify(payload)
}

/** Never retried: a second create for the same order_id would be a second paid order. Pass the exact reviewed body string. */
export async function createOrder(creds: MerchizeCredentials, rawBody: string): Promise<{ id: string | null; raw: unknown }> {
  const json = await call(creds, 'POST', '/order/external/orders', rawBody)
  return { id: str(json?.data?._id), raw: json }
}

/** Starts production of an imported order; without it the order waits when the store's Auto Fulfillment is off. */
export async function pushToProduction(creds: MerchizeCredentials, externalNumber: string, identifier: string): Promise<unknown> {
  return call(creds, 'POST', '/order/external/orders/push', JSON.stringify({ order: { external_number: externalNumber, identifier } }))
}

export async function cancelOrder(creds: MerchizeCredentials, externalNumber: string, identifier: string): Promise<unknown> {
  return call(creds, 'POST', '/order/external/orders/cancel', JSON.stringify({ order: { external_number: externalNumber, identifier } }))
}

/** null when Merchize holds no order under that external number. */
export async function getOrderDetail(creds: MerchizeCredentials, externalNumber: string, identifier: string): Promise<MerchizeRemoteOrder | null> {
  const q = new URLSearchParams({ external_number: externalNumber, identifier })
  let json: any
  try {
    json = await read(creds, `/order/external/orders/order-detail?${q}`)
  } catch (e) {
    if (e instanceof MerchizeError && (e.status === 404 || /does not exist|not found/i.test(e.message))) return null
    throw e
  }
  const d = json?.data
  if (!d || typeof d !== 'object') return null
  return {
    code: str(d.code), id: str(d._id), status: str(d.order_status) ?? str(d.status),
    fulfillmentCost: num(d.fulfillment_cost?.total ?? d.fulfillment_cost),
    shippingCost: num(d.fulfillment_cost?.shipping_cost ?? d.shipping_cost),
  }
}

export async function getOrderTracking(creds: MerchizeCredentials, externalNumber: string, identifier: string): Promise<MerchizeTracking[]> {
  const q = new URLSearchParams({ external_number: externalNumber, identifier })
  let json: any
  try {
    json = await read(creds, `/order/external/orders/tracking?${q}`)
  } catch (e) {
    if (e instanceof MerchizeError && /^Order has not fulfilled(?:[.!]|$)/i.test(e.message)) return []
    throw e
  }
  if (!Array.isArray(json?.data)) throw new MerchizeError('Merchize trả về danh sách tracking không hợp lệ', 502)
  return json.data.filter((p: any) => p?.has_tracking !== false && str(p?.tracking_number)).map((p: any) => ({
    number: str(p.tracking_number)!, company: str(p.tracking_company), url: str(p.tracking_url),
    items: (Array.isArray(p.items) ? p.items : []).map((item: any) => ({
      sku: str(item?.sku), catalogSku: str(item?.ffm_mapped_catalog_sku),
      quantity: num(item?.fulfilled_quantity) ?? num(item?.quantity),
    })),
  }))
}
