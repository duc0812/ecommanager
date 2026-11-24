import { assertSafeExternalUrl } from '@/lib/safe-url'
import { printpossId } from '@/lib/printposs-shared'

const BASE = 'https://api.printposs.com/api/v1/seller'
export class PrintpossError extends Error {
  constructor(message: string, readonly status: number, readonly unknownOutcome = false) {
    super(message)
    this.name = 'PrintpossError'
  }
}

export type PrintpossItem = { product_variant_id: number; quantity: number; design_image_url: string; mockup_image_url: string }
export type PrintpossPayload = {
  external_order_id: string; first_name: string; last_name: string; address_1: string; address_2?: string
  city: string; region: string; zip: string; country: string; email?: string; phone?: string; store_id?: number
  notes?: string; is_sample: boolean; is_fba: boolean; items: PrintpossItem[]
}
export type PrintpossVariant = { id: number; sku: string; name: string; productName: string; active: boolean; baseCost: number | null }
export type PrintpossStore = { id: number; name: string }
export type PrintpossRemoteItem = PrintpossItem & { id: number }
export type PrintpossPackage = {
  id: number; tracking_number: string | null; carrier: string | null; status: string | null
  items?: Array<{ order_item_id: number; quantity: number }>
}
export type PrintpossOrder = {
  order_number: string; external_order_id: string | null; order_status: string | null; payment_status: string | null
  total_cost: number | null; items: PrintpossRemoteItem[]; packages: PrintpossPackage[]
}

const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
const money = (v: unknown) => (typeof v === 'string' && v.trim()) || typeof v === 'number' ? (Number.isFinite(Number(v)) ? Number(v) : null) : null

async function request(token: string, method: 'GET' | 'POST', path: string, body?: string): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), method === 'POST' ? 60_000 : 30_000)
  try {
    const url = assertSafeExternalUrl(`${BASE}${path}`, { allowedHosts: ['api.printposs.com'] })
    let res: Response
    let raw: string
    try {
      res = await fetch(url, {
        method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body } : {}), cache: 'no-store', redirect: 'error', signal: controller.signal,
      })
      raw = await res.text()
    } catch {
      throw new PrintpossError('Không kết nối được Printposs hoặc yêu cầu đã hết thời gian chờ', 0, true)
    }
    let json: any = null
    try { json = JSON.parse(raw) } catch {}
    if (!res.ok || !json || typeof json !== 'object' || json.success === false) {
      const errors = json?.errors && typeof json.errors === 'object'
        ? Object.entries(json.errors).map(([key, v]) => `${key}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ') : ''
      const detail = res.status === 401 ? 'Printposs không nhận API token — kiểm tra token ở Account settings › API Token'
        : [text(json?.message), errors].filter(Boolean).join(': ') || `Printposs trả HTTP ${res.status}`
      // A duplicate reference, server error, or unreadable success cannot prove that no order was created.
      const uncertain = res.status >= 500 || res.status === 408 || res.status === 409 || !json || (method === 'POST' && res.ok)
        || (method === 'POST' && /external_order_id|already|unique|duplicate/i.test(detail))
      throw new PrintpossError(detail.split(token).join('[redacted]').slice(0, 1500), res.status, uncertain)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function allPages(token: string, path: string): Promise<any[]> {
  const rows: any[] = []
  for (let page = 1; page <= 200; page++) {
    const r = await request(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    if (!Array.isArray(r.data)) throw new PrintpossError('Printposs trả danh sách không hợp lệ', 502)
    rows.push(...r.data)
    const last = Number(r.meta?.last_page)
    if (Number.isSafeInteger(last) && last >= 1) {
      if (page >= last) return rows
    } else if (r.links && r.links.next === null) return rows
    else if (r.data.length < 100) return rows
  }
  throw new PrintpossError('Catalog/danh sách Printposs quá lớn — chưa đọc hết, không dùng kết quả một phần', 502)
}

export async function listPrintpossStores(token: string): Promise<PrintpossStore[]> {
  return (await allPages(token, '/stores')).map(s => {
    const id = printpossId(s.id)
    if (!id || !text(s.name)) throw new PrintpossError('Store Printposs không hợp lệ', 502)
    return { id, name: s.name.trim() }
  })
}

export async function listPrintpossVariants(token: string): Promise<PrintpossVariant[]> {
  const out: PrintpossVariant[] = []
  for (const p of await allPages(token, '/products')) {
    if (!Array.isArray(p.variants)) throw new PrintpossError('Catalog Printposs thiếu danh sách variants', 502)
    for (const v of p.variants) {
      const id = printpossId(v.id)
      if (!id || !text(v.sku)) throw new PrintpossError('Catalog Printposs có biến thể không hợp lệ', 502)
      out.push({ id, sku: v.sku.trim(), name: text(v.variant_name) ?? v.sku, productName: text(p.name) ?? '', active: v.is_active === true && p.is_active !== false, baseCost: money(v.base_cost) })
    }
  }
  return out
}

export function printpossOrderOf(value: any): PrintpossOrder | null {
  const code = text(value?.order_number)
  if (!code) return null
  return { ...value, order_number: code, external_order_id: text(value.external_order_id), order_status: text(value.order_status),
    payment_status: text(value.payment_status), total_cost: money(value.total_cost),
    items: Array.isArray(value.items) ? value.items : [], packages: Array.isArray(value.packages) ? value.packages : [] }
}

export async function createPrintpossOrder(token: string, rawBody: string): Promise<PrintpossOrder> {
  const r = await request(token, 'POST', '/orders', rawBody)
  const order = printpossOrderOf(r.data)
  if (!order) throw new PrintpossError('Printposs không trả mã đơn — cần đối chiếu trước khi gửi lại', 502, true)
  return order
}

export async function getPrintpossOrder(token: string, code: string): Promise<PrintpossOrder | null> {
  try {
    const r = await request(token, 'GET', `/orders/${encodeURIComponent(code)}?include=items,packages`)
    const order = printpossOrderOf(r.data)
    if (!order) throw new PrintpossError('Printposs trả thông tin đơn không hợp lệ', 502)
    return order
  } catch (e) {
    if (e instanceof PrintpossError && e.status === 404) return null
    throw e
  }
}

export async function findPrintpossOrder(token: string, externalId: string): Promise<PrintpossOrder | null> {
  // The documented list endpoint has no external-id filter. Complete every page before concluding absence.
  const hits = (await allPages(token, '/orders')).filter(o => o.external_order_id === externalId)
  if (hits.length > 1) throw new PrintpossError('Printposs có nhiều đơn cùng mã ngoài — cần đối chiếu thủ công', 409)
  return hits[0]?.order_number ? getPrintpossOrder(token, hits[0].order_number) : null
}

export function printpossRemoteStatus(o: PrintpossOrder): string | null {
  return [o.order_status, o.payment_status === 'unpaid' ? 'Chưa thanh toán' : null].filter(Boolean).join(' · ') || null
}

const signature = (i: PrintpossItem) => JSON.stringify([i.product_variant_id, i.quantity, i.design_image_url, i.mockup_image_url])

/** Exact item identity and full quantity are required; a line with two parcels waits for manual split handling. */
export function printpossTrackingFor(sent: PrintpossItem[], lineIds: string[], remote: PrintpossOrder): Map<string, { number: string; company: string | null }> {
  const out = new Map<string, { number: string; company: string | null }>()
  if (sent.length !== lineIds.length || ['cancelled', 'canceled', 'failed', 'pending_payment'].includes(remote.order_status ?? '') || remote.payment_status === 'unpaid') return out
  sent.forEach((item, index) => {
    const sig = signature(item)
    if (sent.filter(i => signature(i) === sig).length !== 1) return
    const matches = remote.items.filter(i => signature(i) === sig)
    if (matches.length !== 1 || !printpossId(matches[0].id)) return
    const parcels = remote.packages.filter(p => text(p.tracking_number) && !['cancelled', 'canceled', 'failed', 'voided'].includes(p.status ?? ''))
      .flatMap(p => (p.items ?? []).filter(i => i.order_item_id === matches[0].id).map(i => ({ p, qty: i.quantity })))
    if (parcels.some(p => !Number.isSafeInteger(p.qty) || p.qty <= 0)) return
    const numbers = new Set(parcels.map(p => p.p.tracking_number!.trim()))
    if (numbers.size !== 1 || parcels.reduce((n, p) => n + p.qty, 0) !== item.quantity) return
    out.set(lineIds[index], { number: parcels[0].p.tracking_number!.trim(), company: parcels[0].p.carrier ?? null })
  })
  return out
}
