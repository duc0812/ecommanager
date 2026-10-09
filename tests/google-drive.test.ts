import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { prisma } from '@/lib/db'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import {
  DriveAuthError, ensureFolder, folderForTask, getAccessToken, isDriveConnected, primeAccessToken,
  resetDriveCache, shareAnyoneReader, startResumableUpload, uploadChunk,
} from '@/lib/google-drive'

type Call = { url: string; init: RequestInit }

const KEYS = Object.values(GOOGLE_KEYS)
let calls: Call[] = []

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }))
}

function header(init: RequestInit, name: string) {
  return new Headers(init.headers).get(name)
}

async function connect() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: 'cid.apps.googleusercontent.com' },
      { key: GOOGLE_KEYS.clientSecret, value: 'GOCSPX-secret' },
      { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' },
    ],
  })
}

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  resetDriveCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
})

describe('getAccessToken', () => {
  it('is not connected without a refresh token', async () => {
    expect(await isDriveConnected()).toBe(false)
    await connect()
    expect(await isDriveConnected()).toBe(true)
  })

  it('refreshes once and serves the cached token until 60 s before expiry', async () => {
    await connect()
    mockFetch(() => json({ access_token: 'at-1', expires_in: 3600 }))

    expect(await getAccessToken()).toBe('at-1')
    expect(await getAccessToken()).toBe('at-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    const body = new URLSearchParams(String(calls[0].init.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('1//refresh')
  })

  it('refreshes again when the cached token is inside the 60 s margin', async () => {
    await connect()
    let n = 0
    mockFetch(() => json({ access_token: `at-${++n}`, expires_in: 30 }))
    expect(await getAccessToken()).toBe('at-1')
    expect(await getAccessToken()).toBe('at-2')
    expect(calls).toHaveLength(2)
  })

  it('marks the connection for reconnect on invalid_grant', async () => {
    await connect()
    mockFetch(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400))
    await expect(getAccessToken()).rejects.toBeInstanceOf(DriveAuthError)
    const flag = await prisma.appSetting.findUnique({ where: { key: GOOGLE_KEYS.needsReconnect } })
    expect(flag?.value).toBe('1')
  })
})

describe('Drive calls', () => {
  beforeEach(async () => {
    await connect()
    primeAccessToken('at-primed', 3600, '1//refresh')
  })

  it('ensureFolder reuses an existing folder', async () => {
    mockFetch(() => json({ files: [{ id: 'existing', name: 'Store' }] }))
    expect(await ensureFolder('parent1', 'Store')).toBe('existing')
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe('Bearer at-primed')
  })

  it('ensureFolder creates the folder when missing and escapes quotes and backslashes', async () => {
    mockFetch((url, init) => (init.method === 'POST' ? json({ id: 'created' }) : json({ files: [] })))
    expect(await ensureFolder('parent1', "Bob's \\ shop")).toBe('created')

    const q = new URL(calls[0].url).searchParams.get('q')
    expect(q).toBe("mimeType='application/vnd.google-apps.folder' and name='Bob\\'s \\\\ shop' and 'parent1' in parents and trashed=false")
    expect(calls[1].init.method).toBe('POST')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      name: "Bob's \\ shop", mimeType: 'application/vnd.google-apps.folder', parents: ['parent1'],
    })
  })

  it('folderForTask builds Store/YYYY-MM/Order/Task under the root and caches the path', async () => {
    await prisma.appSetting.create({ data: { key: GOOGLE_KEYS.rootFolderId, value: 'root1' } })
    let id = 0
    mockFetch((url, init) => (init.method === 'POST' ? json({ id: `f${++id}` }) : json({ files: [] })))
    const input = { storeName: 'Litzzy', placedAt: new Date('2026-10-05T12:00:00Z'), orderNumber: '#LIT1', taskKey: 'T-1' }

    expect(await folderForTask(input)).toBe('f4')
    const names = calls.filter(c => c.init.method === 'POST').map(c => JSON.parse(String(c.init.body)))
    expect(names.map(n => n.name)).toEqual(['Litzzy', '2026-10', '#LIT1', 'T-1'])
    expect(names[0].parents).toEqual(['root1'])
    expect(names[3].parents).toEqual(['f3'])

    const before = calls.length
    expect(await folderForTask(input)).toBe('f4')
    expect(calls.length).toBe(before)
  })

  it('startResumableUpload sends the upload headers and returns the Location', async () => {
    mockFetch(() => new Response(null, { status: 200, headers: { Location: 'https://upload.example/session-1' } }))
    const url = await startResumableUpload({ name: 'a.png', mimeType: 'image/png', size: 12345, parentId: 'folder1' })

    expect(url).toBe('https://upload.example/session-1')
    expect(calls[0].url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')).toBe(true)
    expect(calls[0].init.method).toBe('POST')
    expect(header(calls[0].init, 'X-Upload-Content-Type')).toBe('image/png')
    expect(header(calls[0].init, 'X-Upload-Content-Length')).toBe('12345')
    expect(header(calls[0].init, 'Content-Type')).toBe('application/json; charset=UTF-8')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'a.png', mimeType: 'image/png', parents: ['folder1'] })
  })

  it('uploadChunk returns nextStart on 308 and the file on the final response', async () => {
    mockFetch(() => new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } }))
    const first = await uploadChunk('https://upload.example/s', Buffer.from('abcd'), 0, 6)
    expect(first).toEqual({ done: false, nextStart: 4 })
    expect(header(calls[0].init, 'Content-Range')).toBe('bytes 0-3/6')
    expect(calls[0].init.method).toBe('PUT')

    mockFetch(() => json({ id: 'file1', name: 'a.png' }, 201))
    const last = await uploadChunk('https://upload.example/s', Buffer.from('ef'), 4, 6)
    expect(last).toEqual({ done: true, file: { id: 'file1', name: 'a.png' } })
    expect(header(calls[0].init, 'Content-Range')).toBe('bytes 4-5/6')
  })

  it('uploadChunk restarts from 0 when a 308 carries no Range', async () => {
    mockFetch(() => new Response(null, { status: 308 }))
    expect(await uploadChunk('https://upload.example/s', Buffer.from('ab'), 0, 4)).toEqual({ done: false, nextStart: 0 })
  })

  it('shareAnyoneReader posts an anyone/reader permission', async () => {
    mockFetch(() => json({ id: 'anyoneWithLink' }))
    await shareAnyoneReader('file1')
    expect(calls[0].url.startsWith('https://www.googleapis.com/drive/v3/files/file1/permissions')).toBe(true)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ role: 'reader', type: 'anyone' })
  })
})
