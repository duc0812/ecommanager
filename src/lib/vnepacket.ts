import { assertSafeExternalUrl } from '@/lib/safe-url'

const BASE_URL = 'https://api.vnepacket.com.vn'
const HOST = 'api.vnepacket.com.vn'
const TIMEOUT_MS = 30_000

export class VnepacketError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // True when the answer says the token is missing, expired or wrong: a new login fixes it.
    readonly authFailed = false,
    readonly noResponse = false,
  ) {
    super(message)
    this.name = 'VnepacketError'
  }
}

export type VnepacketSession = { token: () => Promise<string>; renew: () => Promise<string> }

export type VnepacketEvent = { time: string; desc: string; location: string | null }

export type VnepacketTracking = {
  reference: string
  trackingNumber: string | null
  carrier: string | null
  status: string | null
  labelUrl: string | null
  checkedIn: boolean
  events: VnepacketEvent[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

// Errors come back as HTTP 200 with {status: "error" | "fail", message}.
const AUTH_MESSAGE = /authori[sz]|token|unauthori[sz]ed|expired|jwt/i

async function request(method: 'GET' | 'POST', path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
  const url = assertSafeExternalUrl(`${BASE_URL}${path}`, { allowedHosts: [HOST] })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let status = 0
  let text = ''
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    })
    status = res.status
    text = await res.text()
  } catch (e: any) {
    const timedOut = e?.name === 'AbortError' || controller.signal.aborted
    throw new VnepacketError(timedOut ? `VNEpacket không phản hồi sau ${TIMEOUT_MS / 1000}s` : `Không kết nối được VNEpacket: ${e?.message ?? e}`, 0, false, true)
  } finally {
    clearTimeout(timer)
  }
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  if (status === 401 || status === 403) throw new VnepacketError(str(json?.message) ?? `VNEpacket từ chối (HTTP ${status})`, status, true)
  if (status < 200 || status >= 300) throw new VnepacketError(str(json?.message) ?? `VNEpacket trả về HTTP ${status}`, status)
  if (!json || typeof json !== 'object') throw new VnepacketError('VNEpacket trả về dữ liệu không phải JSON', status)
  if (json.status !== 'success') {
    const message = str(json.message) ?? `VNEpacket báo lỗi (${String(json.status ?? 'không rõ')})`
    throw new VnepacketError(message, status, AUTH_MESSAGE.test(message))
  }
  return json
}

/** The token the API gives has no stated lifetime; a JWT carries its own expiry, anything else is used until refused. */
export function tokenExpiry(token: string): string | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const exp = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))?.exp
    return typeof exp === 'number' && exp > 0 ? new Date(exp * 1000).toISOString() : null
  } catch {
    return null
  }
}

export async function login(username: string, password: string): Promise<{ token: string; fullName: string | null; expiresAt: string | null }> {
  const json = await request('POST', '/me', { body: { username, password } })
  const token = str(json.access_token)
  if (!token) throw new VnepacketError('VNEpacket không trả về access_token', 200)
  return { token, fullName: str(json.fullName), expiresAt: tokenExpiry(token) }
}

async function call(session: VnepacketSession, path: string): Promise<any> {
  try {
    return await request('GET', path, { token: await session.token() })
  } catch (e) {
    if (!(e instanceof VnepacketError) || !e.authFailed) throw e
    return request('GET', path, { token: await session.renew() })
  }
}

/** "/Date(1724411700000)/" and "2024-08-30 11:40:00" both come back from the API. */
function eventTime(raw: unknown): string | null {
  const s = str(raw)
  if (!s) return null
  const ms = s.match(/\/Date\((\d+)\)\//)
  if (ms) return new Date(Number(ms[1])).toISOString()
  return s
}

export function parseTracking(reference: string, json: any): VnepacketTracking {
  const t = json?.tracking ?? {}
  const details = Array.isArray(t?.events?.statusDetails) ? t.events.statusDetails : Array.isArray(t?.events) ? t.events : []
  const events: VnepacketEvent[] = details
    .map((e: any) => ({ time: eventTime(e?.date) ?? '', desc: str(e?.description) ?? '', location: str(e?.location) }))
    .filter((e: VnepacketEvent) => e.desc || e.time)
  return {
    reference,
    trackingNumber: str(t.tracking_number),
    carrier: str(t.carrier),
    status: str(t.status),
    labelUrl: str(t.label_path),
    checkedIn: t.is_checkin === true,
    events,
  }
}

const RETRY_LATER = /too many|rate limit|try again|server error|internal/i

/**
 * The tracking of one shipment by its reference. `tracking` is null when VNEpacket has no shipment under it; `message`
 * then says what it answered. A refused login, a timeout or a server fault throws: that is no answer about the parcel.
 */
export async function getTracking(session: VnepacketSession, reference: string): Promise<{ tracking: VnepacketTracking | null; message: string | null }> {
  try {
    return { tracking: parseTracking(reference, await call(session, `/tracking/get/${encodeURIComponent(reference)}`)), message: null }
  } catch (e) {
    const answered = e instanceof VnepacketError && !e.authFailed && !e.noResponse && (e.status === 404 || e.status === 200)
    if (answered && !RETRY_LATER.test(e.message)) return { tracking: null, message: e.message }
    throw e
  }
}

/**
 * Shipment status buckets (status-bucket.ts). The API's own status ("_delivered") comes first, then the newest event:
 * a label alone is not a parcel on its way.
 */
export function shipmentStatusOf(t: Pick<VnepacketTracking, 'status' | 'events' | 'checkedIn' | 'trackingNumber'>): string {
  const raw = (t.status ?? '').toLowerCase().replace(/^_+/, '')
  const newest = [...t.events].sort((a, b) => b.time.localeCompare(a.time))[0]?.desc.toLowerCase() ?? ''
  const has = (re: RegExp) => re.test(raw) || re.test(newest)
  if (has(/deliver(ed|y complete)|^delivered/) && !/out for deliver|attempt/.test(newest)) return 'DELIVERED'
  if (has(/out[ _]for[ _]deliver/)) return 'OUT_FOR_DELIVERY'
  if (has(/return|exception|fail|undeliverable|attempt/)) return 'EXCEPTION'
  if (has(/cancel/)) return 'EXCEPTION'
  // Checked in = the HPW warehouse holds the parcel: it left Gỗ 3D even when no carrier scan came back yet.
  if (/transit/.test(raw) || t.checkedIn || t.events.some(e => !/label created/i.test(e.desc))) return 'IN_TRANSIT'
  return t.trackingNumber ? 'INFO_RECEIVED' : 'PENDING'
}

/** Shipments are created under "#" + the code the supplier writes ("#LIT5166_1"); the bare code is tried after. */
export function lineReferences(lineKey: string): string[] {
  return [`#${lineKey}`, lineKey]
}

/** A parcel that holds the whole order is under its order number ("#LIT4986"). */
export function orderReferences(orderNumber: string): string[] {
  const order = orderNumber.replace(/^#/, '')
  return [`#${order}`, order]
}
