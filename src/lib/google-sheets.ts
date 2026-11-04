import { deleteSettings, saveSetting } from '@/lib/token-store'
import { GOOGLE_KEYS, GOOGLE_TOKEN_URL, getGoogleConfig } from '@/lib/google-oauth'
import { getSettings } from '@/lib/token-store'

const API = 'https://sheets.googleapis.com/v4/spreadsheets'
const TIMEOUT_MS = 30_000
const REFRESH_MARGIN_MS = 60_000

export class SheetsError extends Error {
  constructor(message: string, public code: string, public status = 502) {
    super(message)
    this.name = 'SheetsError'
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sheetsTokenCache: { refreshToken: string; token: string; expiresAt: number } | null | undefined
}

/** The Sheets connection is its own consent, so it can be granted or lost without touching the Drive uploads. */
export async function getSheetsConnection(): Promise<{ connected: boolean; email: string; needsReconnect: boolean }> {
  const s = await getSettings([GOOGLE_KEYS.sheetsRefreshToken, GOOGLE_KEYS.sheetsEmail, GOOGLE_KEYS.sheetsNeedsReconnect])
  return { connected: !!s[GOOGLE_KEYS.sheetsRefreshToken], email: s[GOOGLE_KEYS.sheetsEmail] ?? '', needsReconnect: s[GOOGLE_KEYS.sheetsNeedsReconnect] === '1' }
}

export async function saveSheetsConnection(refreshToken: string, email: string | null): Promise<void> {
  await saveSetting(GOOGLE_KEYS.sheetsRefreshToken, refreshToken)
  if (email) await saveSetting(GOOGLE_KEYS.sheetsEmail, email)
  else await deleteSettings([GOOGLE_KEYS.sheetsEmail])
  await deleteSettings([GOOGLE_KEYS.sheetsNeedsReconnect])
  global.__sheetsTokenCache = null
}

async function accessToken(): Promise<string> {
  const cfg = await getGoogleConfig()
  const refreshToken = (await getSettings([GOOGLE_KEYS.sheetsRefreshToken]))[GOOGLE_KEYS.sheetsRefreshToken]
  if (!cfg.clientId || !cfg.clientSecret || !refreshToken) throw new SheetsError('Google Sheets chưa được kết nối.', 'NOT_CONNECTED', 409)
  const cached = global.__sheetsTokenCache
  if (cached && cached.refreshToken === refreshToken && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.access_token !== 'string') {
    global.__sheetsTokenCache = null
    if (data.error === 'invalid_grant') {
      await saveSetting(GOOGLE_KEYS.sheetsNeedsReconnect, '1')
      throw new SheetsError('Google Sheets cần kết nối lại (quyền đã hết hạn hoặc bị thu hồi).', 'NEEDS_RECONNECT', 409)
    }
    throw new SheetsError(`Không làm mới được quyền Google Sheets (HTTP ${res.status}).`, 'TOKEN')
  }
  global.__sheetsTokenCache = { refreshToken, token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 }
  return data.access_token
}

async function call(path: string, init?: RequestInit): Promise<any> {
  const token = await accessToken()
  let res: Response
  try {
    res = await fetch(`${API}/${path}`, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e: any) {
    throw new SheetsError(`Không gọi được Google Sheets: ${e?.message ?? e}`, 'NETWORK')
  }
  const data: any = await res.json().catch(() => null)
  if (!res.ok) {
    const message = data?.error?.message ?? `HTTP ${res.status}`
    // Google answers 403 for an API switched off in the Cloud project too; that is no fault of the account or the sheet.
    if (res.status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(JSON.stringify(data ?? ''))) {
      throw new SheetsError('Google Sheets API chưa bật trong Google Cloud của tool. Bật API đó, chờ vài phút rồi thử lại.', 'API_DISABLED', 409)
    }
    if (res.status === 403) throw new SheetsError(`Tài khoản Google không có quyền ghi sheet này: ${message}`, 'FORBIDDEN', 403)
    throw new SheetsError(`Google Sheets từ chối: ${message}`, 'API')
  }
  return data
}

const quoted = (tab: string) => `'${tab.replace(/'/g, "''")}'`
const rangePath = (range: string) => encodeURIComponent(range)

export async function listTabs(spreadsheetId: string): Promise<string[]> {
  const data = await call(`${spreadsheetId}?fields=sheets.properties.title`)
  return (data?.sheets ?? []).map((s: any) => String(s?.properties?.title ?? ''))
}

export async function readRange(spreadsheetId: string, tab: string, range: string): Promise<string[][]> {
  const data = await call(`${spreadsheetId}/values/${rangePath(`${quoted(tab)}!${range}`)}?majorDimension=ROWS`)
  return (data?.values ?? []) as string[][]
}

/**
 * Adds rows under the tab's table, as new rows, so no cell that exists is overwritten. RAW keeps a customer's text as text:
 * a name starting with "=" must not run as a formula. Returns the range Google wrote, to read back.
 */
export async function appendRows(spreadsheetId: string, tab: string, rows: string[][]): Promise<string> {
  const q = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' })
  const data = await call(`${spreadsheetId}/values/${rangePath(`${quoted(tab)}!A1`)}:append?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  })
  const range = data?.updates?.updatedRange
  if (typeof range !== 'string') throw new SheetsError('Google Sheets không báo vùng đã ghi.', 'NO_RANGE')
  return range
}

export async function readWrittenRange(spreadsheetId: string, range: string): Promise<string[][]> {
  const data = await call(`${spreadsheetId}/values/${rangePath(range)}?majorDimension=ROWS`)
  return (data?.values ?? []) as string[][]
}
