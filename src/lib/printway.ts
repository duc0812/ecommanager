import { assertSafeExternalUrl } from '@/lib/safe-url'
import type { SkuOption } from '@/lib/supplier-sku-suggest'

const PRODUCTION_URL = 'https://apis.printway.io/v3'
const ALLOWED_HOSTS = ['apis.printway.io', 'uat.printway.work']
const DEFAULT_TIMEOUT_MS = 30_000

export const PRINTWAY_SUPPLIER_KEY = 'printway'

export function isPrintwaySupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === PRINTWAY_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === PRINTWAY_SUPPLIER_KEY
}

export class PrintwayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
    // True when no HTTP answer came back (timeout, network): the request may still have been processed.
    readonly noResponse = false,
  ) {
    super(message)
    this.name = 'PrintwayError'
  }
}

export type PrintwayArea =
  | 'artwork_front' | 'artwork_back' | 'artwork_right' | 'artwork_left' | 'artwork_hood' | 'artwork_bothsides'

export type PrintwayOrderItem = { item_sku: string; quantity: number; mockup_url?: string } & Partial<Record<PrintwayArea, string>>

export type PrintwayOrderPayload = {
  order_id: string
  firstName: string
  lastName: string
  shipping_phone?: string
  shipping_address1: string
  shipping_address2?: string
  shipping_city: string
  shipping_province: string
  shipping_province_code: string
  shipping_zip: string
  shipping_country: string
  shipping_country_code: string
  shipping_service?: string
  order_items: PrintwayOrderItem[]
}

export type PrintwayTracking = { number: string; company: string | null; sku: string | null }
export type PrintwayRemoteOrder = { pwOrderId: string | null; status: string | null; tracking: PrintwayTracking[] }

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

// The docs show no sample answer, so the fields are read wherever the request samples suggest they sit.
function payloadOf(json: any): any {
  return json?.data ?? json?.result ?? json
}

function errorMessage(json: any, text: string, status: number): string {
  const fromErrors = json?.errors ? (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors).slice(0, 500)) : null
  return str(json?.message) ?? str(json?.msg) ?? str(json?.error) ?? fromErrors
    ?? (text.trim() && !text.trim().startsWith('<') ? text.trim().slice(0, 500) : `Printway trả về HTTP ${status}`)
}

function refusedInBody(json: any): boolean {
  if (!json || typeof json !== 'object') return false
  if (json.success === false || json.status === false || json.status === 'error' || json.error === true) return true
  return typeof json.code === 'number' && (json.code < 200 || json.code >= 300)
}

function baseUrl(): string {
  return (process.env.PRINTWAY_API_URL?.trim() || PRODUCTION_URL).replace(/\/+$/, '')
}

async function call(token: string, method: 'GET' | 'POST', path: string, body?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  const url = assertSafeExternalUrl(`${baseUrl()}${path}`, { allowedHosts: ALLOWED_HOSTS })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    status = res.status
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new PrintwayError(
      timedOut ? `Printway không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được Printway: ${e?.message ?? e}`,
      0, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (status < 200 || status >= 300 || refusedInBody(json)) {
    throw new PrintwayError(errorMessage(json, text, status), status, json ?? text.slice(0, 2000))
  }
  return json
}

function rowsIn(data: any): any[] {
  if (Array.isArray(data)) return data
  for (const key of ['items', 'rows', 'list', 'skus', 'data', 'products']) {
    if (Array.isArray(data?.[key])) return data[key]
  }
  return []
}

// The catalogue answers one row per product with its SKUs under `variants`; a flat SKU row is read too. A SKU listed twice keeps its first row.
export async function listAllSkus(token: string): Promise<SkuOption[]> {
  const json = await call(token, 'GET', '/products/list-sku-catalogs')
  const seen = new Set<string>()
  return rowsIn(payloadOf(json)).flatMap(r => {
    const productName = str(r?.product_name) ?? str(r?.name)
    const rows: any[] = Array.isArray(r?.variants) ? r.variants : [r]
    return rows.flatMap(v => {
      const skuName = str(v?.item_sku) ?? str(v?.sku)
      if (!skuName || seen.has(skuName)) return []
      seen.add(skuName)
      return [{ skuName, skuCode: str(v?.variant_id), productName }]
    })
  })
}

/** Creates nothing: Printway prices and checks the order without keeping it. */
export async function quoteOrder(token: string, body: unknown): Promise<unknown> {
  return payloadOf(await call(token, 'POST', '/order/calculate-price', JSON.stringify(body)))
}

/** Never retried: a second create could be a second order. Pass the exact reviewed body. */
export async function createOrder(token: string, rawBody: string): Promise<{ pwOrderId: string | null; raw: unknown }> {
  const json = await call(token, 'POST', '/order/create-new-order', rawBody)
  const data = payloadOf(json)
  return { pwOrderId: str(data?.pw_order_id) ?? str(data?.order?.pw_order_id), raw: json }
}

/** Charges the Printway account. Never retried on no answer: it may already have gone through. */
export async function payOrder(token: string, pwOrderId: string): Promise<void> {
  await call(token, 'POST', '/order/paid', JSON.stringify({ order_id: pwOrderId }))
}

export async function cancelOrder(token: string, pwOrderId: string): Promise<void> {
  await call(token, 'POST', '/order/cancel-order-api', JSON.stringify({ pw_order_id: pwOrderId }))
}

function itemsOf(order: any): any[] {
  return [order?.orderitems, order?.order_items].find(Array.isArray) ?? []
}

// The live answer lists items under `orderitems`, each with a `tracking` object, and the order's numbers under `trackings`,
// in camelCase; the snake_case shape is read too. A number an item names keeps its SKU and is not listed again for the order.
function trackingsOf(order: any): PrintwayTracking[] {
  const out: PrintwayTracking[] = []
  const add = (src: any, sku: string | null) => {
    const number = str(src?.tracking_number) ?? str(src?.trackingNumber)
    if (!number || out.some(t => t.number === number)) return
    out.push({ number, company: str(src?.carrier_name) ?? str(src?.carrierName) ?? str(src?.carrier_code) ?? str(src?.carrierCode), sku })
  }
  for (const item of itemsOf(order)) {
    add(item, str(item?.item_sku))
    if (item?.tracking && typeof item.tracking === 'object') add(item.tracking, str(item?.item_sku))
  }
  add(order, null)
  for (const t of Array.isArray(order?.trackings) ? order.trackings : []) add(t, null)
  return out
}

/** The order under our order number; null when Printway holds none. */
export async function findOrder(token: string, orderName: string): Promise<PrintwayRemoteOrder | null> {
  const q = new URLSearchParams({ order_name: orderName })
  let json: any
  try {
    json = await call(token, 'GET', `/order/detail?${q}`)
  } catch (e) {
    if (e instanceof PrintwayError && e.status === 404) return null
    throw e
  }
  const data = payloadOf(json)
  const order = Array.isArray(data) ? data[0] : data?.order ?? data
  if (!order || typeof order !== 'object') return null
  const pwOrderId = str(order.pw_order_id)
  if (!pwOrderId) return null
  return { pwOrderId, status: str(order.order_status) ?? str(order.status) ?? str(itemsOf(order)[0]?.order_status), tracking: trackingsOf(order) }
}

/** The tracking of a line: the one naming its SKU, or the order's only number. Different numbers with no SKU match stay unassigned rather than guessed. */
export function trackingForLine(apiSku: string | null | undefined, tracking: PrintwayTracking[]): PrintwayTracking | null {
  const named = apiSku ? tracking.find(t => t.sku === apiSku) : null
  if (named) return named
  const numbers = new Set(tracking.map(t => t.number))
  return numbers.size === 1 ? tracking[0] : null
}

const DIAL_CODES: Record<string, string> = { US: '1', CA: '1', GB: '44', AU: '61', NZ: '64', IE: '353' }
const E164 = /^\+[1-9]\d{7,14}$/

/** Printway asks for E.164. Shopify holds many numbers as typed; null when one cannot be made valid with confidence. */
export function e164Phone(raw: string | null | undefined, countryCode: string | null): string | null {
  const text = (raw ?? '').trim()
  if (!/\d/.test(text) || /[a-z]/i.test(text)) return null
  const digits = text.replace(/\D/g, '')
  if (text.startsWith('+')) return E164.test(`+${digits}`) ? `+${digits}` : null
  if (digits.startsWith('00')) return E164.test(`+${digits.slice(2)}`) ? `+${digits.slice(2)}` : null
  const dial = countryCode ? DIAL_CODES[countryCode] : undefined
  if (!dial) return null
  if (digits.startsWith('0')) {
    const local = `+${dial}${digits.slice(1)}`
    return E164.test(local) ? local : null
  }
  const nationalLength = dial === '1' ? 10 : null
  if (digits.startsWith(dial) && (nationalLength === null || digits.length === nationalLength + dial.length)) {
    return E164.test(`+${digits}`) ? `+${digits}` : null
  }
  const local = `+${dial}${digits}`
  return E164.test(local) ? local : null
}

const SIDES: Array<{ area: PrintwayArea; match: RegExp }> = [
  { area: 'artwork_back', match: /back|mặt sau/i },
  { area: 'artwork_hood', match: /hood|mũ/i },
  { area: 'artwork_right', match: /right|phải/i },
  { area: 'artwork_left', match: /left|trái/i },
  { area: 'artwork_bothsides', match: /both/i },
  { area: 'artwork_front', match: /front|mặt trước|artwork/i },
]

/** The Printway print area of one part. A line's only part is the front whatever its name: older files are named after the line ("LIT5789_1"). */
export function printwayAreaFor(part: string, allParts: string[]): PrintwayArea | null {
  return SIDES.find(s => s.match.test(part))?.area ?? (allParts.length === 1 ? 'artwork_front' : null)
}
