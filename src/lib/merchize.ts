import { assertSafeExternalUrl } from '@/lib/safe-url'

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
  ) {
    super(message)
    this.name = 'MerchizeError'
  }
}

/** The store's bo-api base URL and token live in the server env, never in the DB or the browser. */
export function merchizeCredentials(): MerchizeCredentials | null {
  const baseUrl = process.env.MERCHIZE_API_URL?.trim().replace(/\/+$/, '')
  const token = process.env.MERCHIZE_API_TOKEN?.trim()
  return baseUrl && token ? { baseUrl, token } : null
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
  printing_method: MerchizePrintingMethod; image: string
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
  tracking: { number: string; company: string | null; url: string | null }[]
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
    throw new MerchizeError(errorMessage(json, text, status), status, json ?? text.slice(0, 2000))
  }
  if (json === null) throw new MerchizeError('Merchize trả về dữ liệu không phải JSON', status, text.slice(0, 2000))
  return json
}

export async function searchCatalog(creds: MerchizeCredentials, skus: string[]): Promise<MerchizeCatalogProduct[]> {
  const q = new URLSearchParams({ limit: '50', page: '1', search: skus.join(',') })
  const json = await call(creds, 'GET', `/product/catalog?${q}`)
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
    json = await call(creds, 'GET', `/order/external/orders/order-detail?${q}`)
  } catch (e) {
    if (e instanceof MerchizeError && (e.status === 404 || /does not exist|not found/i.test(e.message))) return null
    throw e
  }
  const d = json?.data
  if (!d || typeof d !== 'object') return null
  const fulfillments: any[] = Array.isArray(d.fulfillments) ? d.fulfillments : []
  return {
    code: str(d.code), id: str(d._id), status: str(d.order_status) ?? str(d.status),
    fulfillmentCost: num(d.fulfillment_cost?.total ?? d.fulfillment_cost),
    shippingCost: num(d.fulfillment_cost?.shipping_cost ?? d.shipping_cost),
    tracking: fulfillments
      .map(f => ({ number: str(f?.tracking_number) ?? '', company: str(f?.tracking_company), url: str(f?.tracking_url) }))
      .filter(t => t.number),
  }
}
