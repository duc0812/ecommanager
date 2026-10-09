import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { GOOGLE_KEYS, saveGoogleOAuthState } from '@/lib/google-oauth'
import { resetDriveCache } from '@/lib/google-drive'
import { GET as startOAuth } from '@/app/api/auth/google/route'
import { GET as callback } from '@/app/api/auth/google/callback/route'
import { GET as getSetup, PUT as putSetup, DELETE as deleteSetup } from '@/app/api/setup/google-drive/route'

type Call = { url: string; init: RequestInit }

const KEYS = Object.values(GOOGLE_KEYS)
const BASE = 'http://localhost:3002'
const ACCESS = 'ya29.access-token-value'
const REFRESH = '1//refresh-token-value'
let calls: Call[] = []
let superToken = ''
let adminToken = ''
const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }))
}

function req(path: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(`${BASE}${path}`, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

async function setting(key: string) {
  return (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null
}

async function saveClient() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: 'cid-123456789.apps.googleusercontent.com' },
      { key: GOOGLE_KEYS.clientSecret, value: 'GOCSPX-very-secret' },
    ],
  })
}

function googleSuccess(url: string, init: RequestInit) {
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599 })
  if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return json({ email: 'owner@gmail.com' })
  if (url.startsWith('https://www.googleapis.com/drive/v3/files')) {
    return init.method === 'POST' ? json({ id: 'root-folder-1' }) : json({ files: [] })
  }
  return json({ error: 'unexpected' }, 500)
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  delete process.env.NEXT_PUBLIC_APP_URL
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@gdrive.test' }, create: { name: 'Super', email: 'super@gdrive.test', role: 'SUPERADMIN' }, update: {} })).id
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@gdrive.test' }, create: { name: 'Admin', email: 'admin@gdrive.test', role: 'ADMIN' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@gdrive.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
  adminToken = await signToken({ userId: adminId, email: 'admin@gdrive.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
})

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  resetDriveCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['super@gdrive.test', 'admin@gdrive.test'] } } })
  if (savedAppUrl !== undefined) process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
})

describe('access rules', () => {
  it('callback is public, start and setup are superadmin-only', () => {
    expect(canCallApi(null, [], '/api/auth/google/callback', 'GET')).toBe('ok')
    expect(canCallApi(null, [], '/api/auth/google', 'GET')).toBe('unauthenticated')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/auth/google', 'GET')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/setup/google-drive', 'GET')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/setup/google-drive', 'PUT')).toBe('ok')
  })
})

describe('GET /api/auth/google', () => {
  it('redirects a superadmin to the Google consent screen with offline access and a state', async () => {
    await saveClient()
    const res = await startOAuth(req('/api/auth/google', superToken))
    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const p = location.searchParams
    expect(p.get('client_id')).toBe('cid-123456789.apps.googleusercontent.com')
    expect(p.get('redirect_uri')).toBe('http://localhost:3002/api/auth/google/callback')
    expect(p.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file')
    expect(p.get('access_type')).toBe('offline')
    expect(p.get('prompt')).toBe('consent')
    expect(p.get('include_granted_scopes')).toBe('true')
    expect(p.get('state')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('rejects an admin with 403', async () => {
    await saveClient()
    const res = await startOAuth(req('/api/auth/google', adminToken))
    expect(res.status).toBe(403)
  })
})

describe('GET /api/auth/google/callback', () => {
  it('rejects a missing state with 400', async () => {
    mockFetch(googleSuccess)
    const res = await callback(req('/api/auth/google/callback?code=abc', null))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown state with 400', async () => {
    mockFetch(googleSuccess)
    const res = await callback(req('/api/auth/google/callback?code=abc&state=deadbeef', null))
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('stores the refresh token and email, creates the root folder and redirects without leaking tokens', async () => {
    await saveClient()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.needsReconnect, value: '1' } })
    saveGoogleOAuthState('state-ok')
    mockFetch(googleSuccess)

    const res = await callback(req('/api/auth/google/callback?code=auth-code&state=state-ok', null))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3002/setup?google=connected')

    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe(REFRESH)
    expect(await setting(GOOGLE_KEYS.email)).toBe('owner@gmail.com')
    expect(await setting(GOOGLE_KEYS.rootFolderId)).toBe('root-folder-1')
    expect(await setting(GOOGLE_KEYS.needsReconnect)).toBeNull()

    const exchange = new URLSearchParams(String(calls[0].init.body))
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('auth-code')
    expect(exchange.get('redirect_uri')).toBe('http://localhost:3002/api/auth/google/callback')
    const folderCreate = calls.find(c => c.init.method === 'POST' && c.url.startsWith('https://www.googleapis.com/drive'))!
    expect(JSON.parse(String(folderCreate.init.body))).toMatchObject({ name: 'Design Studio', parents: ['root'] })

    let raw = await res.text()
    res.headers.forEach((value, key) => { raw += ` ${key}: ${value}` })
    expect(raw).not.toContain(ACCESS)
    expect(raw).not.toContain(REFRESH)
  })

  it('keeps the stored refresh token when Google does not return a new one', async () => {
    await saveClient()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.refreshToken, value: 'old-refresh' } })
    saveGoogleOAuthState('state-keep')
    mockFetch((url, init) => (url === 'https://oauth2.googleapis.com/token'
      ? json({ access_token: ACCESS, expires_in: 3599 })
      : googleSuccess(url, init)))

    const res = await callback(req('/api/auth/google/callback?code=c&state=state-keep', null))
    expect(res.headers.get('location')).toBe('http://localhost:3002/setup?google=connected')
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe('old-refresh')
  })

  it('redirects with an error reason when the token exchange fails', async () => {
    await saveClient()
    saveGoogleOAuthState('state-bad-code')
    mockFetch(() => json({ error: 'invalid_grant' }, 400))

    const res = await callback(req('/api/auth/google/callback?code=c&state=state-bad-code', null))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3002/setup?google=error&reason=invalid_grant')
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBeNull()
  })
})

describe('/api/setup/google-drive', () => {
  it('GET masks the client id, hides the secret and never returns the refresh token', async () => {
    await saveClient()
    await prisma.appSetting.createMany({
      data: [
        { key: GOOGLE_KEYS.refreshToken, value: REFRESH },
        { key: GOOGLE_KEYS.email, value: 'owner@gmail.com' },
        { key: GOOGLE_KEYS.rootFolderId, value: 'root-folder-1' },
      ],
    })
    const res = await getSetup(req('/api/setup/google-drive', superToken))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('GOCSPX-very-secret')
    expect(text).not.toContain(REFRESH)
    expect(text).not.toContain('cid-123456789.apps.googleusercontent.com')
    const body = JSON.parse(text)
    expect(body).toMatchObject({
      configured: true,
      connected: true,
      email: 'owner@gmail.com',
      rootFolderId: 'root-folder-1',
      rootFolderUrl: 'https://drive.google.com/drive/folders/root-folder-1',
      needsReconnect: false,
      hasClientSecret: true,
    })
    expect(body.clientIdMasked).toBe('cid-….com')
  })

  it('PUT trims values and an empty string clears', async () => {
    const res = await putSetup(req('/api/setup/google-drive', superToken, {
      method: 'PUT', body: JSON.stringify({ clientId: '  my-client  ', clientSecret: ' sec ' }),
    }))
    expect(res.status).toBe(200)
    expect(await setting(GOOGLE_KEYS.clientId)).toBe('my-client')
    expect(await setting(GOOGLE_KEYS.clientSecret)).toBe('sec')

    await putSetup(req('/api/setup/google-drive', superToken, { method: 'PUT', body: JSON.stringify({ clientSecret: '' }) }))
    expect(await setting(GOOGLE_KEYS.clientSecret)).toBeNull()
    expect(await setting(GOOGLE_KEYS.clientId)).toBe('my-client')
  })

  it('PUT and DELETE return 403 for an admin', async () => {
    await saveClient()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.refreshToken, value: REFRESH } })
    const put = await putSetup(req('/api/setup/google-drive', adminToken, { method: 'PUT', body: JSON.stringify({ clientId: 'x' }) }))
    expect(put.status).toBe(403)
    const del = await deleteSetup(req('/api/setup/google-drive', adminToken, { method: 'DELETE' }))
    expect(del.status).toBe(403)
    expect(await setting(GOOGLE_KEYS.clientId)).toBe('cid-123456789.apps.googleusercontent.com')
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe(REFRESH)
  })

  it('DELETE disconnects but keeps the client credentials', async () => {
    await saveClient()
    await prisma.appSetting.createMany({
      data: [
        { key: GOOGLE_KEYS.refreshToken, value: REFRESH },
        { key: GOOGLE_KEYS.email, value: 'owner@gmail.com' },
        { key: GOOGLE_KEYS.rootFolderId, value: 'root-folder-1' },
      ],
    })
    const res = await deleteSetup(req('/api/setup/google-drive', superToken, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBeNull()
    expect(await setting(GOOGLE_KEYS.email)).toBeNull()
    expect(await setting(GOOGLE_KEYS.rootFolderId)).toBeNull()
    expect(await setting(GOOGLE_KEYS.clientId)).not.toBeNull()
    expect(await setting(GOOGLE_KEYS.clientSecret)).not.toBeNull()
  })
})
