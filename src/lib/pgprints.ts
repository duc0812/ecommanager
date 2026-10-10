import { createHmac } from 'crypto'
import { assertSafeExternalUrl } from '@/lib/safe-url'

export const PGPRINTS_HOST = 'https://app.pgprints.io'
const PGPRINTS_HOSTNAME = 'app.pgprints.io'
const DEFAULT_TIMEOUT_MS = 30_000

export type PgprintsCredentials = { storeId: string; secretKey: string }

export class PgprintsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
    // True when no HTTP answer came back (timeout, network): the request may still have been processed.
    readonly noResponse = false,
  ) {
    super(message)
    this.name = 'PgprintsError'
  }
}

export type PgprintsAddress = {
  first_name: string; last_name: string; name: string; email: string; phone: string
  address1: string; address2: string; company: string; city: string; zip: string
  province: string; province_code: string; country: string; country_code: string
}

export type PgprintsLineItem = {
  name: string; refId: string; quantity: number; sku: string; shipClass: string
  fileUrls: string[]; mockupImages: string[]
}

export type PgprintsOrderPayload = {
  order_id: string
  email: string
  shipping_address: PgprintsAddress
  customer: { first_name: string; last_name: string }
  line_items: PgprintsLineItem[]
  response_type: 'normal'
  production_note?: string
}

export type PgprintsBalance = { availableAmount: number; pendingAmount: number; paidAmount: number; upcomingAmount: number }

export type PgprintsCreatedOrder = {
  id: string | null; pgcOrderId: string | null; orderId: string | null
  totalCost: number | null; shippingFee: number | null; handleFee: number | null
  childDetails: unknown[]
}

export type PgprintsCatalogProduct = {
  sku: string; name: string
  files: { name: string; note: string | null; sizeWidth: number | null; sizeHeight: number | null }[]
  shipClasses: string[]
  variants: { sku: string }[]
}

export type PgprintsRemoteOrder = {
  id: string | null; pgcOrderId: string | null; orderId: string | null
  itemStatuses: string[]
  totalCost: number | null; shippingFee: number | null; handleFee: number | null
  items: { sku: string | null; status: string | null; trackingNumber: string | null; carrierCode: string | null }[]
}

export function signBody(secretKey: string, rawBody: string): string {
  return createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('base64')
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

function list(v: unknown): any[] {
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    for (const key of ['content', 'items', 'list', 'docs', 'data']) {
      const inner = (v as any)[key]
      if (Array.isArray(inner)) return inner
    }
  }
  return []
}

function errorMessage(json: any, text: string, status: number): string {
  const fromJson = json && typeof json === 'object'
    ? str(json.message) ?? str(json.error) ?? str(json.msg) ?? (json.errors ? JSON.stringify(json.errors).slice(0, 500) : null)
    : null
  return fromJson ?? (text.trim() ? text.trim().slice(0, 500) : `PGprints trả về HTTP ${status}`)
}

async function call(creds: PgprintsCredentials, method: 'POST' | 'PUT', path: string, rawBody: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  if (!creds.storeId || !creds.secretKey) throw new PgprintsError('Chưa cấu hình Store ID / Secret key PGprints', 400)
  const url = assertSafeExternalUrl(`${PGPRINTS_HOST}${path}`, { allowedHosts: [PGPRINTS_HOSTNAME] })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-PGPrints-Store-Id': creds.storeId,
        'X-PGPrints-Hmac-Sha256': signBody(creds.secretKey, rawBody),
      },
      body: rawBody,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    status = res.status
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new PgprintsError(
      timedOut ? `PGprints không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được PGprints: ${e?.message ?? e}`,
      0, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (status < 200 || status >= 300 || json?.success === false) {
    throw new PgprintsError(errorMessage(json, text, status), status, json ?? text.slice(0, 2000))
  }
  if (json === null) throw new PgprintsError('PGprints trả về dữ liệu không phải JSON', status, text.slice(0, 2000))
  return json
}

export async function getBalance(creds: PgprintsCredentials): Promise<PgprintsBalance> {
  const json = await call(creds, 'POST', '/api/v1/users/balance', '{}')
  const d = json?.data ?? {}
  return {
    availableAmount: num(d.availableAmount) ?? 0,
    pendingAmount: num(d.pendingAmount) ?? 0,
    paidAmount: num(d.paidAmount) ?? 0,
    upcomingAmount: num(d.upcomingAmount) ?? 0,
  }
}

export async function searchProducts(creds: PgprintsCredentials, input: { searchKey: string; page?: number; size?: number }): Promise<PgprintsCatalogProduct[]> {
  const body = JSON.stringify({ searchKey: input.searchKey, page: input.page ?? 1, size: input.size ?? 20 })
  const json = await call(creds, 'POST', '/api/v1/productNormals/search', body)
  return list(json?.data).map((p: any) => ({
    sku: str(p?.sku) ?? '',
    name: str(p?.name) ?? '',
    files: list(p?.files).map((f: any) => ({
      name: str(f?.name) ?? '', note: str(f?.note), sizeWidth: num(f?.sizeWidth), sizeHeight: num(f?.sizeHeight),
    })),
    shipClasses: list(p?.shipClasses).map((s: any) => (typeof s === 'string' ? s : str(s?.name) ?? '')).filter(Boolean),
    variants: list(p?.variants).map((v: any) => ({ sku: str(v?.sku) ?? '' })).filter(v => v.sku),
  })).filter(p => p.sku)
}

export function serializeOrderPayload(payload: PgprintsOrderPayload): string {
  return JSON.stringify(payload)
}

/** Never retried: a second create for the same order would be a second paid order. Pass the exact reviewed body string. */
export async function createOrder(creds: PgprintsCredentials, rawBody: string): Promise<{ order: PgprintsCreatedOrder; raw: unknown }> {
  const json = await call(creds, 'POST', '/app/v1/orders/create', rawBody)
  const d = json?.data ?? {}
  return {
    raw: json,
    order: {
      id: str(d.id), pgcOrderId: str(d.pgcOrderId), orderId: str(d.orderId),
      totalCost: num(d.totalCost), shippingFee: num(d.shippingFee), handleFee: num(d.handleFee),
      childDetails: list(d.childDetails),
    },
  }
}

export async function cancelOrder(creds: PgprintsCredentials, orderId: string): Promise<unknown> {
  return call(creds, 'PUT', '/api/v1/order/cancel', JSON.stringify({ orderId }))
}

export async function searchOrders(
  creds: PgprintsCredentials,
  input: { fromTime: number; toTime: number; searchKey?: string; page?: number; size?: number },
): Promise<PgprintsRemoteOrder[]> {
  const body = JSON.stringify({
    fromTime: input.fromTime, toTime: input.toTime, searchKey: input.searchKey ?? '', page: input.page ?? 1, size: input.size ?? 20,
  })
  const json = await call(creds, 'POST', '/api/v1/orders/search', body)
  return list(json?.data).map((o: any) => ({
    id: str(o?.id), pgcOrderId: str(o?.pgcOrderId), orderId: str(o?.orderId),
    itemStatuses: list(o?.itemStatuses).filter((s: any): s is string => typeof s === 'string'),
    totalCost: num(o?.totalCost), shippingFee: num(o?.shippingFee), handleFee: num(o?.handleFee),
    items: list(o?.childDetails).map((c: any) => ({
      sku: str(c?.sku), status: str(c?.status),
      trackingNumber: str(c?.trackingNumber) ?? str(c?.tracking?.trackingNumber),
      carrierCode: str(c?.carrierCode) ?? str(c?.tracking?.carrierCode),
    })),
  }))
}
