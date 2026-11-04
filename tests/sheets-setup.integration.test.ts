import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { GOOGLE_KEYS, SHEETS_SCOPE, SHEETS_STATE_PREFIX, saveGoogleOAuthState } from '@/lib/google-oauth'
import { SHEET_CHANNELS_KEY, getSheetChannels, tabNameFor } from '@/lib/sheet-channel'
import { DELETE, GET, PUT } from '@/app/api/setup/google-sheets/route'
import { GET as callback } from '@/app/api/auth/google/callback/route'

const URL_SETUP = 'http://x/api/setup/google-sheets'
const KEYS = [GOOGLE_KEYS.clientId, GOOGLE_KEYS.clientSecret, GOOGLE_KEYS.refreshToken, GOOGLE_KEYS.sheetsRefreshToken, GOOGLE_KEYS.sheetsEmail, GOOGLE_KEYS.sheetsNeedsReconnect, SHEET_CHANNELS_KEY]

let superToken = ''
let adminToken = ''
let tabs: string[]
let tokenScope: string

const set = (key: string, value: string) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
const setting = async (key: string) => (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null

function req(method: string, token: string | null, body?: unknown) {
  const r = new NextRequest(URL_SETUP, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

async function runCallback(prefix: string) {
  const state = `${prefix}abc123`
  saveGoogleOAuthState(state)
  return callback(new NextRequest(`http://x/api/auth/google/callback?state=${state}&code=c1`))
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  const make = async (email: string, role: 'SUPERADMIN' | 'ADMIN') => {
    const permissions = DEFAULT_ROLE_PERMISSIONS.ADMIN
    const u = await prisma.appUser.upsert({ where: { email }, create: { name: role, email, role, permissions: JSON.stringify(permissions) }, update: {} })
    return signToken({ userId: u.id, email, name: role, role, permissions, tv: 0 })
  }
  superToken = await make('super@sheets.test', 'SUPERADMIN')
  adminToken = await make('admin@sheets.test', 'ADMIN')
})

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await set(GOOGLE_KEYS.clientId, 'cid')
  await set(GOOGLE_KEYS.clientSecret, 'sec')
  await set(GOOGLE_KEYS.refreshToken, 'drive-token')
  global.__sheetsTokenCache = null
  tabs = [tabNameFor('ORDER {M}-{YYYY}', new Date())]
  tokenScope = `openid email ${SHEETS_SCOPE}`
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input)
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('oauth2.googleapis.com')) return json({ access_token: 'tok', expires_in: 3600, refresh_token: 'sheets-token', scope: tokenScope })
    if (url.includes('userinfo')) return json({ email: 'setads@example.com' })
    if (url.includes('sheets.googleapis.com')) return json({ sheets: tabs.map(title => ({ properties: { title } })) })
    return json({})
  }))
})

afterEach(() => vi.unstubAllGlobals())

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['super@sheets.test', 'admin@sheets.test'] } } })
})

describe('Setup card', () => {
  it('is for the super admin only', async () => {
    expect((await GET(req('GET', null))).status).toBe(401)
    expect((await GET(req('GET', adminToken))).status).toBe(403)
    expect((await PUT(req('PUT', adminToken, { supplierCode: 'jomall', enabled: true }))).status).toBe(403)
    expect((await DELETE(req('DELETE', adminToken))).status).toBe(403)
  })

  it('lists Jomall switched off before anything is saved, and hands out no token', async () => {
    await set(GOOGLE_KEYS.sheetsRefreshToken, 'sheets-token')
    const res = await GET(req('GET', superToken))
    const text = await res.text()
    expect(text).not.toContain('sheets-token')
    expect(JSON.parse(text)).toMatchObject({ configured: true, connected: true, channels: [{ supplierCode: 'jomall', enabled: false }] })
  })

  it('will not switch on without a connection', async () => {
    const res = await PUT(req('PUT', superToken, { supplierCode: 'jomall', enabled: true }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NOT_CONNECTED')
    expect(await getSheetChannels()).toEqual([])
  })

  it('will not switch on when the month has no tab', async () => {
    await set(GOOGLE_KEYS.sheetsRefreshToken, 'sheets-token')
    tabs = ['Draft']
    const res = await PUT(req('PUT', superToken, { supplierCode: 'jomall', enabled: true }))
    expect((await res.json()).code).toBe('NO_TAB')
    expect(await getSheetChannels()).toEqual([])
  })

  it('switches on and off, and keeps the connection while a channel is on', async () => {
    await set(GOOGLE_KEYS.sheetsRefreshToken, 'sheets-token')
    expect((await PUT(req('PUT', superToken, { supplierCode: 'jomall', enabled: true }))).status).toBe(200)
    expect((await getSheetChannels())[0]).toMatchObject({ supplierCode: 'jomall', enabled: true })
    expect((await DELETE(req('DELETE', superToken))).status).toBe(409)
    expect(await setting(GOOGLE_KEYS.sheetsRefreshToken)).toBe('sheets-token')

    expect((await PUT(req('PUT', superToken, { supplierCode: 'jomall', enabled: false }))).status).toBe(200)
    expect((await DELETE(req('DELETE', superToken))).status).toBe(200)
    expect(await setting(GOOGLE_KEYS.sheetsRefreshToken)).toBeNull()
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe('drive-token')
  })

  it('says the API is off in Google Cloud, instead of blaming the account', async () => {
    await set(GOOGLE_KEYS.sheetsRefreshToken, 'sheets-token')
    vi.stubGlobal('fetch', vi.fn(async (input: any) => (String(input).includes('oauth2.googleapis.com')
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 403, message: 'Google Sheets API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED' } }), { status: 403 }))))
    const res = await PUT(req('PUT', superToken, { supplierCode: 'jomall', enabled: true }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('API_DISABLED')
    expect(body.error).not.toContain('không có quyền')
    expect(await getSheetChannels()).toEqual([])
  })

  it('refuses a supplier with no channel', async () => {
    expect((await PUT(req('PUT', superToken, { supplierCode: 'nope', enabled: true }))).status).toBe(404)
  })
})

describe('Google callback for Sheets', () => {
  it('saves the Sheets token apart, leaves Drive alone and returns to Setup', async () => {
    const res = await runCallback(SHEETS_STATE_PREFIX)
    expect(res.headers.get('location')).toContain('/setup?sheets=connected')
    expect(await setting(GOOGLE_KEYS.sheetsRefreshToken)).toBe('sheets-token')
    expect(await setting(GOOGLE_KEYS.sheetsEmail)).toBe('setads@example.com')
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe('drive-token')
  })

  it('reports an unticked permission on the Sheets card, not the Drive one', async () => {
    tokenScope = 'openid email'
    const res = await runCallback(SHEETS_STATE_PREFIX)
    expect(res.headers.get('location')).toContain('/setup?sheets=error&reason=no_sheets_scope')
    expect(await setting(GOOGLE_KEYS.sheetsRefreshToken)).toBeNull()
  })
})
