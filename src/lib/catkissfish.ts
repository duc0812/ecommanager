import { assertSafeExternalUrl } from '@/lib/safe-url'
import { sameLabel } from '@/lib/task-files'
import { CKF_SHIPPING } from '@/lib/catkissfish-shipping'

const BASE_URL = 'https://www.catkissfish.com/website'
const HOST = 'www.catkissfish.com'
const API = '/open/api'
const DEFAULT_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = 45_000
const TOKEN_LIFETIME_S = 2 * 3600
const NO_PERMISSION_CODE = 10000
const BAD_TOKEN_CODE = 6007
// The token call answers code 200 where every other call answers 0 (seen live 11/18/2026; the docs show neither).
const TOKEN_OK_CODES = [0, 200]

export const CATKISSFISH_SUPPLIER_KEY = 'catkissfish'

export function isCatkissfishSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === CATKISSFISH_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === CATKISSFISH_SUPPLIER_KEY
}

/** A carrier by its id or name; null when CatKissFish has no such carrier. */
export function shippingOf(value: string | null | undefined): { id: string; name: string } | null {
  const v = (value ?? '').trim().toLowerCase()
  return (v && CKF_SHIPPING.find(s => s.id.toLowerCase() === v || s.name.toLowerCase() === v)) || null
}

// The tool's SKU was made by hand before the API was read, and its "SKU API" still holds the tool SKU itself.
const STYLE_BY_SKU: Record<string, string> = { 'CKF-KNIT-SCARF-35X193': 'Scarf & Silk Scarf1-14' }

/** The CatKissFish style code of a tool SKU: its "SKU API" unless that only repeats the tool SKU. */
export function styleCodeOf(product: { sku: string; apiSku?: string | null }): string | null {
  const api = product.apiSku?.trim()
  return (api && api !== product.sku ? api : STYLE_BY_SKU[product.sku]) ?? null
}

export const CKF_STATE = { UNPAID: 1, AWAITING_PRODUCTION: 2, IN_PRODUCTION: 3, SHIPPED: 4, FINISHED: 5, CANCELLED: 6, PACKING: 7, REFUND_REQUESTED: 8, REFUNDED: 9 } as const

const STATE_LABELS: Record<number, string> = {
  1: 'Chưa thanh toán', 2: 'Chờ sản xuất', 3: 'Đang sản xuất', 4: 'Đã gửi hàng', 5: 'Hoàn tất',
  6: 'Đã huỷ', 7: 'Đang đóng gói', 8: 'Đang yêu cầu hoàn tiền', 9: 'Đã hoàn tiền',
}

export const CKF_UNPAID_LABEL = STATE_LABELS[CKF_STATE.UNPAID]

export function stateLabelOf(state: number | null): string | null {
  return state === null ? null : STATE_LABELS[state] ?? `Trạng thái ${state}`
}

export const isClosedState = (state: number | null) => state === CKF_STATE.CANCELLED || state === CKF_STATE.REFUNDED

/** A tracking number before the parcel left would tell the shopper it is on its way. A missing state cannot rule that out. */
export const hasLeftFactory = (state: number | null) => state === null || state === CKF_STATE.SHIPPED || state === CKF_STATE.FINISHED

export class CatkissfishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
    readonly body: unknown = null,
    // No clear answer came back (timeout, network, 5xx, unreadable body): the request may still have been processed.
    readonly unknownOutcome = false,
  ) {
    super(message)
    this.name = 'CatkissfishError'
  }
}

/** The token lasts 2 hours and comes from the client id and secret. */
export type CatkissfishSession = { token: () => Promise<string>; renew: () => Promise<string> }

export type CkfImage = { printableDesignArea?: string; imageUrl: string }

export type CkfDesignInfo = {
  styleCode: string
  // The docs' schema says customSku and their sample says customerSku; both carry the line key.
  customSku: string
  customerSku: string
  color: string
  size: string
  quantity: number
  mockupList: CkfImage[]
  designList: CkfImage[]
}

export type CkfShippingAddress = {
  userName: string; country: string; countryAbbreviation: string; province: string; city: string
  detailAddress: string; postalCode: string; email?: string; countryCode?: string; phone?: string
}

export type CkfOrderPayload = { platformOrderId: string; shippingId?: string; designInfos: CkfDesignInfo[]; shippingAddress: CkfShippingAddress }

export type CkfDimension = { fieldName: string; name: string | null; supportUploadFormat: string | null }
export type CkfVariant = { color: string | null; size: string | null; saleState: boolean | null }
export type CkfProduct = { name: string | null; styleCode: string | null; dimensions: CkfDimension[]; variants: CkfVariant[]; colors: string[]; sizes: string[] }
export type CkfRemoteOrder = { id: string; platformOrderId: string | null; state: number | null; stateLabel: string | null }
export type CkfTracking = { name: string | null; key: string | null; number: string }

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const uniq = (values: (string | null)[]) => Array.from(new Set(values.filter((v): v is string => !!v)))

async function exchange(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string; json: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = 0
  let text = ''
  try {
    const res = await fetch(assertSafeExternalUrl(url, { allowedHosts: [HOST] }), { ...init, signal: controller.signal, cache: 'no-store', redirect: 'error' })
    status = res.status
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new CatkissfishError(
      timedOut ? `CatKissFish không phản hồi sau ${Math.round(timeoutMs / 1000)}s` : `Không kết nối được CatKissFish: ${e?.message ?? e}`,
      0, null, null, true,
    )
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status, text, json }
}

function refusalMessage(code: number | null, json: any, text: string, status: number): string {
  if (code === NO_PERMISSION_CODE) return 'CatKissFish báo tài khoản chưa có quyền dùng Open API (mã 10000)'
  const said = str(json?.message) ?? str(json?.msg)
  if (said) return said
  // Some refusals are only a code, such as {"code":1000} for an unknown style.
  if (code !== null) return `CatKissFish báo lỗi mã ${code}`
  return text.trim() && !text.trim().startsWith('<') ? text.trim().slice(0, 500) : `CatKissFish trả về HTTP ${status}`
}

type RequestOptions = { query?: Record<string, string>; body?: string; timeoutMs?: number }

async function request(method: 'GET' | 'POST', path: string, token: string, opts: RequestOptions): Promise<any> {
  const q = opts.query ? `?${new URLSearchParams(opts.query)}` : ''
  const { status, text, json } = await exchange(`${BASE_URL}${API}${path}${q}`, {
    method,
    headers: { Accept: 'application/json', 'access-token': token, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body,
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const code = num(json?.code)
  const detail = json ?? text.slice(0, 2000)
  if (status >= 500) throw new CatkissfishError(refusalMessage(code, json, text, status), status, code, detail, true)
  if (status < 200 || status >= 300) throw new CatkissfishError(refusalMessage(code, json, text, status), status, code, detail)
  // A 200 without the {code} envelope says nothing about whether the request worked.
  if (code === null) throw new CatkissfishError('CatKissFish trả về dữ liệu không đọc được', status, null, detail, true)
  if (code !== 0) throw new CatkissfishError(refusalMessage(code, json, text, status), status, code, detail)
  return json.data
}

// A bad token gets code 6007 from the live API. Its wording counts too. Each of these means nothing was processed.
function isAuthRefusal(e: CatkissfishError): boolean {
  return !e.unknownOutcome && (e.status === 401 || e.code === 401 || e.code === BAD_TOKEN_CODE || e.code === NO_PERMISSION_CODE || /token/i.test(e.message))
}

async function call(session: CatkissfishSession, method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<any> {
  try {
    return await request(method, path, await session.token(), opts)
  } catch (e) {
    if (!(e instanceof CatkissfishError) || !isAuthRefusal(e)) throw e
    return request(method, path, await session.renew(), opts)
  }
}

export async function issueToken(clientId: string, clientSecret: string): Promise<{ token: string; expiresAt: string }> {
  const form = new FormData()
  form.set('grant_type', 'client_credentials')
  form.set('client_id', clientId)
  form.set('client_secret', clientSecret)
  const { status, json } = await exchange(`${BASE_URL}/oauth2/client_token`, { method: 'POST', headers: { Accept: 'application/json' }, body: form }, DEFAULT_TIMEOUT_MS)
  // Live answer: {code:200, msg:"ok", data:{client_token, expires_in, client_id}}. The other names are kept in case it changes.
  const data = json?.data ?? json
  const token = (typeof data === 'string' ? str(data) : null) ?? str(data?.client_token) ?? str(data?.access_token) ?? str(data?.accessToken) ?? str(data?.['access-token']) ?? str(data?.token)
  const code = num(json?.code)
  const accepted = status >= 200 && status < 300 && (code === null || TOKEN_OK_CODES.includes(code))
  if (!accepted || !token) {
    // Only the short message is kept, without the key, since this text reaches screens and logs.
    const said = code === NO_PERMISSION_CODE ? refusalMessage(code, json, '', status) : str(json?.message) ?? str(json?.msg)
    const reason = said ?? (accepted ? 'CatKissFish không trả về access token' : `CatKissFish không cấp token (HTTP ${status})`)
    throw new CatkissfishError(reason.split(clientSecret).join('***').split(clientId).join('***'), status, code)
  }
  const lifetime = num(data?.expires_in) ?? num(data?.expiresIn) ?? TOKEN_LIFETIME_S
  return { token, expiresAt: new Date(Date.now() + lifetime * 1000).toISOString() }
}

function dimensionsOf(v: unknown): CkfDimension[] {
  return list(v).flatMap(x => {
    const fieldName = str(x?.fieldName)
    return fieldName ? [{ fieldName, name: str(x?.name), supportUploadFormat: str(x?.supportUploadFormat) }] : []
  })
}

export async function getProductDetail(session: CatkissfishSession, styleCode: string): Promise<CkfProduct | null> {
  const d = await call(session, 'GET', '/products/detail', { query: { styleCode } })
  if (!d || typeof d !== 'object') return null
  let dimensions = dimensionsOf(d.dimensions)
  if (dimensions.length === 0) {
    // The live detail leaves the design areas out; the API product list carries them (the scarf has one, named "1").
    const page = await call(session, 'POST', '/products/auto/design/list', { body: JSON.stringify({ pageNum: 1, pageSize: 20, styleCode }) })
    dimensions = dimensionsOf(list(page?.records).find(r => str(r?.styleCode) === styleCode)?.dimensions)
  }
  const variants: CkfVariant[] = list(d.colorSizeInfoList).map(v => ({ color: str(v?.color), size: str(v?.size), saleState: typeof v?.saleState === 'boolean' ? v.saleState : null }))
  return {
    name: str(d.name), styleCode: str(d.styleCode),
    dimensions,
    variants,
    colors: uniq([...variants.map(v => v.color), ...list(d.colorInfoList).map(c => str(c?.colorEnName))]),
    sizes: uniq([...variants.map(v => v.size), ...list(d.sizeNameList).map(str)]),
  }
}

/** Never retried by us past an auth refusal: pass the exact reviewed body. The live answer is `data: ["<order id>"]`. */
export async function createAutoDesignOrder(session: CatkissfishSession, rawBody: string): Promise<unknown> {
  return call(session, 'POST', '/order/create/auto/design/order', { body: rawBody, timeoutMs: CREATE_TIMEOUT_MS })
}

function remoteOrderOf(o: any): CkfRemoteOrder | null {
  const id = str(o?.id)
  if (!id) return null
  const state = num(o?.state)
  return { id, platformOrderId: str(o?.shopOrderId), state, stateLabel: stateLabelOf(state) }
}

/** The order under our order number, a live one before a cancelled one. */
export async function findOrder(session: CatkissfishSession, platformOrderId: string): Promise<CkfRemoteOrder | null> {
  const data = await call(session, 'POST', '/order/list', { body: JSON.stringify({ pageNum: 1, pageSize: 20, platformOrderId }) })
  const rows = list(data?.records)
  // The filter is theirs, so the number is checked here; a lone row carrying no number at all is the filter's answer.
  const named = rows.filter(r => str(r?.shopOrderId) === platformOrderId || str(r?.pyShopOrderId) === platformOrderId)
  const hits = named.length > 0 ? named : rows.length === 1 && !str(rows[0]?.shopOrderId) && !str(rows[0]?.pyShopOrderId) ? rows : []
  const orders = hits.map(remoteOrderOf).filter((o): o is CkfRemoteOrder => !!o)
  return orders.find(o => !isClosedState(o.state)) ?? orders[0] ?? null
}

/** The order a create answered with, its state still unknown. */
export function createdOrderOf(data: unknown): CkfRemoteOrder | null {
  return remoteOrderOf({ id: list(data)[0] })
}

export async function getOrder(session: CatkissfishSession, id: string): Promise<CkfRemoteOrder | null> {
  const d = await call(session, 'GET', '/order/detail', { query: { id } })
  // The live detail has no `id` field, so the id asked for is the order's.
  return d && (d.state !== undefined || d.shopOrderId !== undefined) ? remoteOrderOf({ ...d, id: d.id ?? id }) : null
}

export async function cancelOrder(session: CatkissfishSession, id: string): Promise<void> {
  await call(session, 'GET', '/order/cancel', { query: { id } })
}

export async function getTrackingNumbers(session: CatkissfishSession, id: string): Promise<CkfTracking[]> {
  const data = await call(session, 'GET', '/order/query/order/tracking/number', { query: { id } })
  return list(data).flatMap(t => {
    const number = str(t?.logisticNumber)
    return number ? [{ name: str(t?.logisticName), key: str(t?.logisticKey), number }] : []
  })
}

/** The order's one tracking number. Numbers belong to the order, not to a line, so several cannot be shared out: a wrong tracking is worse than none. */
export function singleTracking(rows: CkfTracking[]): CkfTracking | null {
  return new Set(rows.map(r => r.number)).size === 1 ? rows[0] : null
}

export type VariantPick = { color: string | null; size: string | null; problem: string | null }

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function pickValue(wanted: string | null | undefined, options: string[]): string | null {
  const hit = wanted ? options.find(o => sameText(o, wanted)) : undefined
  return hit ?? (options.length === 1 ? options[0] : null)
}

/**
 * The blank's color and size, in CatKissFish's own spelling. They come from the supplier SKU: a Shopify variant here is a
 * design name ("Coral Pink"), not a blank. A product with one color or size needs no match.
 */
export function pickVariant(product: CkfProduct | null, wanted: { color?: string | null; size?: string | null }): VariantPick {
  if (!product) return { color: wanted.color?.trim() || null, size: wanted.size?.trim() || null, problem: null }
  const color = product.colors.length > 0 ? pickValue(wanted.color, product.colors) : wanted.color?.trim() || null
  const size = product.sizes.length > 0 ? pickValue(wanted.size, product.sizes) : wanted.size?.trim() || null
  if (!color) return { color, size, problem: `màu "${wanted.color ?? ''}" không có trong: ${product.colors.join(', ') || 'không rõ'}` }
  if (!size) return { color, size, problem: `size "${wanted.size ?? ''}" không có trong: ${product.sizes.join(', ') || 'không rõ'}` }
  const soldOut = product.variants.some(v => v.saleState === false && !!v.color && !!v.size && sameText(v.color, color) && sameText(v.size, size))
  return { color, size, problem: soldOut ? `${color} / ${size} đang ngừng bán` : null }
}

export type DesignPlan = { list: CkfImage[]; unmatched: string[]; unfilled: string[]; dimensionOf: Map<string, CkfDimension> }

/**
 * Our print parts as CatKissFish's design areas. A print-on-demand style has no areas and takes one file without a name;
 * a style with one area takes our one file there; otherwise parts match areas by name.
 */
export function designListFor(prints: { area: string; publicUrl: string | null }[], dimensions: CkfDimension[]): DesignPlan {
  const dimensionOf = new Map<string, CkfDimension>()
  const url = (p: { publicUrl: string | null }) => p.publicUrl ?? ''
  if (dimensions.length === 0) {
    return { list: prints.slice(0, 1).map(p => ({ imageUrl: url(p) })), unmatched: prints.slice(1).map(p => p.area), unfilled: [], dimensionOf }
  }
  if (dimensions.length === 1 && prints.length === 1) {
    dimensionOf.set(prints[0].area, dimensions[0])
    return { list: [{ printableDesignArea: dimensions[0].fieldName, imageUrl: url(prints[0]) }], unmatched: [], unfilled: [], dimensionOf }
  }
  const out: CkfImage[] = []
  const unmatched: string[] = []
  for (const p of prints) {
    const d = dimensions.find(x => sameLabel(x.fieldName, p.area) || (!!x.name && sameLabel(x.name, p.area)))
    if (!d) { unmatched.push(p.area); continue }
    dimensionOf.set(p.area, d)
    out.push({ printableDesignArea: d.fieldName, imageUrl: url(p) })
  }
  const used = new Set(out.map(i => i.printableDesignArea))
  return { list: out, unmatched, unfilled: dimensions.filter(d => !used.has(d.fieldName)).map(d => d.fieldName), dimensionOf }
}

/** False only when the area names its formats (0 = png, 1 = jpg) and this file is not one of them. */
export function formatAccepted(dimension: CkfDimension | undefined, mimeType: string | null): boolean {
  const formats = (dimension?.supportUploadFormat ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (formats.length === 0 || !mimeType) return true
  return mimeType === 'image/png' ? formats.some(f => f === '0' || f === 'png') : formats.some(f => f === '1' || f === 'jpg' || f === 'jpeg')
}

const DIAL_CODES: Record<string, string> = {
  US: '1', CA: '1', GB: '44', AU: '61', NZ: '64', IE: '353', DE: '49', FR: '33', IT: '39', ES: '34', NL: '31', BE: '32',
  AT: '43', CH: '41', SE: '46', NO: '47', DK: '45', FI: '358', PT: '351', PL: '48', MX: '52', JP: '81', SG: '65',
}

/** The phone as CatKissFish's sample has it: the dialling code apart, digits only. */
export function phoneParts(phone: string | null | undefined, country: string | null): { countryCode?: string; phone?: string } {
  const raw = phone?.trim() ?? ''
  const dial = country ? DIAL_CODES[country] : undefined
  let digits = raw.replace(/\D/g, '')
  if (dial && raw.startsWith('+') && digits.startsWith(dial)) digits = digits.slice(dial.length)
  return { ...(dial ? { countryCode: `+${dial}` } : {}), ...(digits ? { phone: digits } : {}) }
}
