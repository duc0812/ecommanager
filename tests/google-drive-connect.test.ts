import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { CredentialError, MAX_CREDENTIAL_BYTES, parseDriveCredential } from '@/lib/google-drive-connect'
import { POST as connectToken } from '@/app/api/setup/google-drive/connect-token/route'
import { POST as createTest, DELETE as deleteTest } from '@/app/api/setup/google-drive/test/route'
import { GET as getSetup, DELETE as disconnect } from '@/app/api/setup/google-drive/route'

type Call = { url: string; method: string; headers: Headers; body: any }

const KEYS = Object.values(GOOGLE_KEYS)
const BASE = 'http://localhost:3002'
const CLIENT_ID = 'fake-123456.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-fake-secret-value'
const REFRESH = '1//fake-refresh-token-value'
const ACCESS = 'ya29.fake-access-token'
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test-sess'
const GB = 1024 ** 3
let calls: Call[] = []
let superToken = ''
let adminToken = ''

const AUTHORIZED_USER = {
  token: ACCESS,
  refresh_token: REFRESH,
  token_uri: 'https://evil.example/token',
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  universe_domain: 'googleapis.com',
  account: '',
  expiry: '2026-10-01T00:00:00Z',
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

type Overrides = {
  token?: () => Response
  about?: () => Response
  search?: () => Response
  createFolder?: () => Response
  put?: () => Response
  share?: () => Response
}

function googleMock(o: Overrides = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body }
    calls.push(c)
    if (c.url === 'https://oauth2.googleapis.com/token') {
      return o.token ? o.token() : json({ access_token: ACCESS, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' })
    }
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/about')) {
      return o.about ? o.about() : json({ user: { emailAddress: 'owner@gmail.com', displayName: 'Owner' }, storageQuota: { limit: String(15 * GB), usage: String(3 * GB) } })
    }
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return o.search ? o.search() : json({ files: [] })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && c.method === 'POST') {
      return o.createFolder ? o.createFolder() : json({ id: 'root-new' })
    }
    if (c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST') {
      return new Response(null, { status: 200, headers: { Location: SESSION } })
    }
    if (c.url === SESSION && c.method === 'PUT') return o.put ? o.put() : json({ id: 'test-file-1', webViewLink: 'https://drive.google.com/file/d/test-file-1/view?usp=drivesdk' })
    if (c.url.includes('/permissions')) return o.share ? o.share() : json({ id: 'anyoneWithLink' })
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    return json({ error: { message: `unexpected ${c.method} ${c.url}` } }, 500)
  }))
}

function req(path: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(`${BASE}${path}`, init)
  if (token) r.cookies.set(AUTH_COOKIE, token)
  return r
}

function connectReq(body: unknown, token: string | null = superToken) {
  return req('/api/setup/google-drive/connect-token', token, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
}

async function setting(key: string) {
  return (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null
}

async function storedConnection() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: CLIENT_ID },
      { key: GOOGLE_KEYS.clientSecret, value: CLIENT_SECRET },
      { key: GOOGLE_KEYS.refreshToken, value: REFRESH },
      { key: GOOGLE_KEYS.rootFolderId, value: 'root-1' },
    ],
  })
  primeAccessToken(ACCESS, 3600, REFRESH)
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  const superId = (await prisma.appUser.upsert({ where: { email: 'super@gdc.test' }, create: { name: 'Super', email: 'super@gdc.test', role: 'SUPERADMIN' }, update: {} })).id
  const adminId = (await prisma.appUser.upsert({ where: { email: 'admin@gdc.test' }, create: { name: 'Admin', email: 'admin@gdc.test', role: 'ADMIN' }, update: {} })).id
  superToken = await signToken({ userId: superId, email: 'super@gdc.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
  adminToken = await signToken({ userId: adminId, email: 'admin@gdc.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
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
  await prisma.appUser.deleteMany({ where: { email: { in: ['super@gdc.test', 'admin@gdc.test'] } } })
})

describe('parseDriveCredential', () => {
  const want = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH }

  it('reads the authorized-user file', () => {
    expect(parseDriveCredential({ tokenJson: JSON.stringify(AUTHORIZED_USER) })).toEqual(want)
    expect(parseDriveCredential({ tokenJson: `﻿${JSON.stringify(AUTHORIZED_USER, null, 2)}\n` })).toEqual(want)
  })

  it('reads an installed or web client file combined with a separate refresh token', () => {
    const installed = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uris: ['http://localhost'] } })
    expect(parseDriveCredential({ tokenJson: installed, refreshToken: ` ${REFRESH} ` })).toEqual(want)
    const web = JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } })
    expect(parseDriveCredential({ tokenJson: web, refreshToken: REFRESH })).toEqual(want)
    expect(() => parseDriveCredential({ tokenJson: installed })).toThrow(/Khoá thiếu: refresh_token/)
  })

  it('reads the three values typed by hand', () => {
    expect(parseDriveCredential({ clientId: ` ${CLIENT_ID}`, clientSecret: CLIENT_SECRET, refreshToken: REFRESH })).toEqual(want)
  })

  it('rejects garbage with a Vietnamese message', () => {
    expect(() => parseDriveCredential(null)).toThrow(CredentialError)
    expect(() => parseDriveCredential('x')).toThrow(/không hợp lệ/)
    expect(() => parseDriveCredential({ tokenJson: 'not json at all' })).toThrow(/không phải JSON hợp lệ/)
    expect(() => parseDriveCredential({ tokenJson: '[1,2]' })).toThrow(/không đúng định dạng/)
    expect(() => parseDriveCredential({ tokenJson: 42 })).toThrow(/dạng chữ/)
    expect(() => parseDriveCredential({ tokenJson: '{}' })).toThrow(/Khoá thiếu: client_id, client_secret, refresh_token/)
    expect(() => parseDriveCredential({ tokenJson: JSON.stringify({ ...AUTHORIZED_USER, refresh_token: 5 }) })).toThrow(/Khoá thiếu: refresh_token/)
    expect(() => parseDriveCredential({ tokenJson: JSON.stringify({ type: 'service_account', client_id: 'x', private_key: 'k' }) })).toThrow(/service account/)
    expect(() => parseDriveCredential({ clientId: 'a b', clientSecret: 's', refreshToken: 'r' })).toThrow(/không hợp lệ/)
    expect(() => parseDriveCredential({})).toThrow(/Khoá thiếu/)
  })

  it('rejects a file over 16 KB', () => {
    const big = JSON.stringify({ ...AUTHORIZED_USER, padding: 'x'.repeat(MAX_CREDENTIAL_BYTES) })
    let thrown: any
    try { parseDriveCredential({ tokenJson: big }) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(CredentialError)
    expect(thrown.status).toBe(413)
    expect(thrown.message).toMatch(/lớn hơn 16 KB/)
  })
})

describe('POST /api/setup/google-drive/connect-token', () => {
  it('is superadmin-only', async () => {
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/setup/google-drive/connect-token', 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/setup/google-drive/test', 'POST')).toBe('forbidden')
    googleMock()
    expect((await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }, adminToken))).status).toBe(403)
    expect((await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }, null))).status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBeNull()
  })

  it('validates with Google, stores the connection and never returns a secret', async () => {
    await prisma.appSetting.createMany({ data: [{ key: GOOGLE_KEYS.needsReconnect, value: '1' }, { key: GOOGLE_KEYS.testFileId, value: 'old-test' }] })
    googleMock()
    const res = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const secret of [CLIENT_SECRET, REFRESH, ACCESS, CLIENT_ID]) expect(text).not.toContain(secret)
    const body = JSON.parse(text)
    expect(body).toMatchObject({
      ok: true, email: 'owner@gmail.com', displayName: 'Owner', rootFolderId: 'root-new', rootFolderCreated: true,
      rootFolderUrl: 'https://drive.google.com/drive/folders/root-new', warning: null,
    })
    expect(body.quota).toMatchObject({ limit: 15 * GB, usage: 3 * GB })

    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(String(calls[0].body))
    expect(Object.fromEntries(form)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH, grant_type: 'refresh_token' })
    expect(calls.some(c => c.url.includes('evil.example'))).toBe(false)
    const about = calls.find(c => c.url.includes('/drive/v3/about'))!
    expect(about.url).toBe('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)')
    expect(about.headers.get('Authorization')).toBe(`Bearer ${ACCESS}`)
    const folder = calls.find(c => c.method === 'POST' && c.url.startsWith('https://www.googleapis.com/drive/v3/files'))!
    expect(JSON.parse(folder.body)).toMatchObject({ name: 'Design Studio', parents: ['root'] })

    expect(await setting(GOOGLE_KEYS.clientId)).toBe(CLIENT_ID)
    expect(await setting(GOOGLE_KEYS.clientSecret)).toBe(CLIENT_SECRET)
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe(REFRESH)
    expect(await setting(GOOGLE_KEYS.email)).toBe('owner@gmail.com')
    expect(await setting(GOOGLE_KEYS.rootFolderId)).toBe('root-new')
    expect(await setting(GOOGLE_KEYS.needsReconnect)).toBeNull()
    expect(await setting(GOOGLE_KEYS.testFileId)).toBeNull()
    expect(JSON.parse((await setting(GOOGLE_KEYS.quota))!)).toMatchObject({ limit: 15 * GB, usage: 3 * GB })

    const status = await getSetup(req('/api/setup/google-drive', superToken))
    const statusText = await status.text()
    for (const secret of [CLIENT_SECRET, REFRESH, ACCESS, CLIENT_ID]) expect(statusText).not.toContain(secret)
    expect(JSON.parse(statusText)).toMatchObject({ connected: true, needsReconnect: false, email: 'owner@gmail.com', quota: { limit: 15 * GB, usage: 3 * GB }, hasTestFile: false })
  })

  it('reuses an existing Design Studio folder and accepts the manual fields', async () => {
    googleMock({ search: () => json({ files: [{ id: 'root-existing', name: 'Design Studio' }] }) })
    const res = await connectToken(connectReq({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rootFolderId: 'root-existing', rootFolderCreated: false })
    expect(calls.some(c => c.method === 'POST' && c.url.startsWith('https://www.googleapis.com/drive/v3/files'))).toBe(false)
  })

  it('an account without a storage limit stores a null limit', async () => {
    googleMock({ about: () => json({ user: { emailAddress: 'ws@corp.test' }, storageQuota: { usage: '1024' } }) })
    const res = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect((await res.json()).quota).toMatchObject({ limit: null, usage: 1024 })
  })

  it.each([
    ['invalid_grant', /Refresh token đã bị thu hồi hoặc hết hạn/],
    ['invalid_client', /Client ID hoặc Client Secret không đúng/],
    ['unauthorized_client', /không được dùng refresh token này/],
    ['server_error', /Google từ chối khoá này \(server_error\)/],
  ])('maps the token error %s to a clear message and stores nothing', async (code, message) => {
    googleMock({ token: () => json({ error: code, error_description: 'Bad Request' }, 400) })
    const res = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(JSON.parse(text).error).toMatch(message)
    expect(text).not.toContain(REFRESH)
    expect(calls).toHaveLength(1)
    expect(await prisma.appSetting.count({ where: { key: { in: KEYS } } })).toBe(0)
  })

  it('refuses a key without a Drive scope', async () => {
    googleMock({ token: () => json({ access_token: ACCESS, expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/userinfo.email' }) })
    const res = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/không có quyền Google Drive/)
    expect(calls).toHaveLength(1)
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBeNull()

    googleMock({ token: () => json({ access_token: ACCESS, expires_in: 3599 }) })
    expect((await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))).status).toBe(400)

    googleMock({ token: () => json({ access_token: ACCESS, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive' }) })
    expect((await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))).status).toBe(200)
  })

  it('keeps the previous connection when Drive refuses the about call or the root folder', async () => {
    await prisma.appSetting.createMany({ data: [{ key: GOOGLE_KEYS.refreshToken, value: 'previous-refresh' }, { key: GOOGLE_KEYS.clientId, value: 'previous-client' }] })
    googleMock({ about: () => json({ error: { message: 'Google Drive API has not been used in project 123' } }, 403) })
    const res = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Google Drive API has not been used in project 123/)
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBe('previous-refresh')

    googleMock({ createFolder: () => json({ error: { message: 'The user has exceeded their Drive storage quota' } }, 403) })
    const second = await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect(second.status).toBe(502)
    expect((await second.json()).error).toMatch(/không tạo được thư mục "Design Studio".*storage quota/)
    expect(await setting(GOOGLE_KEYS.clientId)).toBe('previous-client')
  })

  it('refuses an oversized or malformed body before calling Google', async () => {
    googleMock()
    const big = await connectToken(connectReq({ tokenJson: JSON.stringify({ ...AUTHORIZED_USER, padding: 'x'.repeat(17 * 1024) }) }))
    expect(big.status).toBe(413)
    expect((await big.json()).error).toMatch(/16 KB/)
    const huge = await connectToken(connectReq({ tokenJson: 'x'.repeat(60 * 1024) }))
    expect(huge.status).toBe(413)
    const bad = await connectToken(connectReq('{not json'))
    expect(bad.status).toBe(400)
    const garbage = await connectToken(connectReq({ tokenJson: 'hello' }))
    expect(garbage.status).toBe(400)
    expect((await garbage.json()).error).toMatch(/JSON hợp lệ/)
    expect(calls).toHaveLength(0)
  })

  it('disconnect clears the quota snapshot with the connection', async () => {
    googleMock()
    await connectToken(connectReq({ tokenJson: JSON.stringify(AUTHORIZED_USER) }))
    expect((await disconnect(req('/api/setup/google-drive', superToken, { method: 'DELETE' }))).status).toBe(200)
    expect(await setting(GOOGLE_KEYS.quota)).toBeNull()
    expect(await setting(GOOGLE_KEYS.refreshToken)).toBeNull()
    expect(await setting(GOOGLE_KEYS.clientId)).toBe(CLIENT_ID)
  })
})

describe('/api/setup/google-drive/test', () => {
  it('uploads a tiny PNG into the root folder, shares it and returns the link', async () => {
    await storedConnection()
    googleMock()
    const res = await createTest(req('/api/setup/google-drive/test', superToken, { method: 'POST' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, fileId: 'test-file-1', link: 'https://drive.google.com/file/d/test-file-1/view?usp=drivesdk' })
    expect(body.name).toMatch(/^drive-test-.*\.png$/)

    const init = calls.find(c => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!
    expect(JSON.parse(init.body)).toMatchObject({ mimeType: 'image/png', parents: ['root-1'] })
    const put = calls.find(c => c.method === 'PUT')!
    const png = put.body as Buffer
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.length).toBeLessThan(200)
    const share = calls.find(c => c.url.includes('/files/test-file-1/permissions'))!
    expect(JSON.parse(share.body)).toEqual({ role: 'reader', type: 'anyone' })
    expect(await setting(GOOGLE_KEYS.testFileId)).toBe('test-file-1')
  })

  it('deletes the test file on request, and the previous one before making a new one', async () => {
    await storedConnection()
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.testFileId, value: 'older-test' } })
    googleMock()
    await createTest(req('/api/setup/google-drive/test', superToken, { method: 'POST' }))
    const firstDelete = calls.findIndex(c => c.method === 'DELETE' && c.url.includes('/files/older-test'))
    expect(firstDelete).toBeGreaterThanOrEqual(0)
    expect(firstDelete).toBeLessThan(calls.findIndex(c => c.method === 'PUT'))

    googleMock()
    const res = await deleteTest(req('/api/setup/google-drive/test', superToken, { method: 'DELETE' }))
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['DELETE https://www.googleapis.com/drive/v3/files/test-file-1'])
    expect(await setting(GOOGLE_KEYS.testFileId)).toBeNull()

    googleMock()
    expect(await (await deleteTest(req('/api/setup/google-drive/test', superToken, { method: 'DELETE' }))).json()).toEqual({ ok: true, deleted: false })
    expect(calls).toHaveLength(0)
  })

  it('shows what Google said when the upload or the share fails, and leaves no orphan', async () => {
    await storedConnection()
    googleMock({ put: () => json({ error: { message: 'File not found: root-1.' } }, 404) })
    const res = await createTest(req('/api/setup/google-drive/test', superToken, { method: 'POST' }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.googleMessage).toBe('File not found: root-1. (HTTP 404)')
    expect(body.error).toBe('Chưa tạo được file thử trên Google Drive. Google trả lời: "File not found: root-1. (HTTP 404)"')
    expect(await setting(GOOGLE_KEYS.testFileId)).toBeNull()

    googleMock({ share: () => json({ error: { message: 'Sharing is disabled for this domain' } }, 403) })
    const shared = await createTest(req('/api/setup/google-drive/test', superToken, { method: 'POST' }))
    expect((await shared.json()).googleMessage).toMatch(/Sharing is disabled for this domain/)
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/files/test-file-1'))).toBe(true)
    expect(await setting(GOOGLE_KEYS.testFileId)).toBeNull()
  })

  it('needs a connection and a superadmin', async () => {
    googleMock()
    expect((await createTest(req('/api/setup/google-drive/test', superToken, { method: 'POST' }))).status).toBe(400)
    await storedConnection()
    expect((await createTest(req('/api/setup/google-drive/test', adminToken, { method: 'POST' }))).status).toBe(403)
    expect((await deleteTest(req('/api/setup/google-drive/test', adminToken, { method: 'DELETE' }))).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
