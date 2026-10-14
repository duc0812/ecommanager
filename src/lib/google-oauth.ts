import { getSettings } from '@/lib/token-store'

export const GOOGLE_KEYS = {
  clientId: 'google.oauth.clientId',
  clientSecret: 'google.oauth.clientSecret',
  refreshToken: 'google.drive.refreshToken',
  email: 'google.drive.email',
  rootFolderId: 'google.drive.rootFolderId',
  needsReconnect: 'google.drive.needsReconnect',
  quota: 'google.drive.quota',
  testFileId: 'google.drive.testFileId',
} as const

export const GOOGLE_CONNECTION_KEYS: string[] = [
  GOOGLE_KEYS.refreshToken, GOOGLE_KEYS.email, GOOGLE_KEYS.rootFolderId, GOOGLE_KEYS.needsReconnect, GOOGLE_KEYS.quota, GOOGLE_KEYS.testFileId,
]

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const GOOGLE_SCOPES = 'openid email https://www.googleapis.com/auth/drive.file'
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']

const STATE_TTL_MS = 10 * 60 * 1000

declare global {
  // eslint-disable-next-line no-var
  var __googleOAuthStates: Map<string, number> | undefined
}

function states() {
  if (!global.__googleOAuthStates) global.__googleOAuthStates = new Map()
  return global.__googleOAuthStates
}

export type DriveQuota = { limit: number | null; usage: number; checkedAt: string }

export type GoogleConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
  email: string
  rootFolderId: string
  needsReconnect: boolean
  quota: DriveQuota | null
  testFileId: string
}

export function parseDriveQuota(json: string | null | undefined): DriveQuota | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    const usage = Number(v?.usage)
    if (!Number.isFinite(usage) || usage < 0 || typeof v?.checkedAt !== 'string') return null
    const limit = v.limit === null || v.limit === undefined ? null : Number(v.limit)
    return { limit: limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null, usage, checkedAt: v.checkedAt }
  } catch { return null }
}

export function isDriveConfigured(cfg: Pick<GoogleConfig, 'clientId' | 'clientSecret' | 'refreshToken'>): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken)
}

export async function getGoogleConfig(): Promise<GoogleConfig> {
  const s = await getSettings(Object.values(GOOGLE_KEYS))
  return {
    clientId: s[GOOGLE_KEYS.clientId] ?? '',
    clientSecret: s[GOOGLE_KEYS.clientSecret] ?? '',
    refreshToken: s[GOOGLE_KEYS.refreshToken] ?? '',
    email: s[GOOGLE_KEYS.email] ?? '',
    rootFolderId: s[GOOGLE_KEYS.rootFolderId] ?? '',
    needsReconnect: s[GOOGLE_KEYS.needsReconnect] === '1',
    quota: parseDriveQuota(s[GOOGLE_KEYS.quota]),
    testFileId: s[GOOGLE_KEYS.testFileId] ?? '',
  }
}

export function googleAppUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3002').trim().replace(/\/+$/, '')
}

export function googleRedirectUri(): string {
  return `${googleAppUrl()}/api/auth/google/callback`
}

export function saveGoogleOAuthState(state: string) {
  const now = Date.now()
  const map = states()
  map.forEach((createdAt, key) => { if (now - createdAt > STATE_TTL_MS) map.delete(key) })
  map.set(state, now)
}

export function consumeGoogleOAuthState(state: string): boolean {
  if (!state) return false
  const map = states()
  const createdAt = map.get(state)
  map.delete(state)
  return createdAt !== undefined && Date.now() - createdAt <= STATE_TTL_MS
}

export function buildGoogleConsentUrl(clientId: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

export type GoogleTokenResponse = {
  access_token: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export class GoogleOAuthError extends Error {
  constructor(message: string, public code: string) {
    super(message)
    this.name = 'GoogleOAuthError'
  }
}

export async function exchangeGoogleCode(code: string, clientId: string, clientSecret: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: 'authorization_code',
    }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) {
    throw new GoogleOAuthError(`Token exchange failed (HTTP ${res.status})`, typeof data.error === 'string' ? data.error : 'token_exchange')
  }
  return data
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return ''
  const data: any = await res.json().catch(() => ({}))
  return typeof data.email === 'string' ? data.email : ''
}
