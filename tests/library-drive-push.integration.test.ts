import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { pushLibraryFileToDrive } from '@/lib/design-drive-push'
import { GET as serveRoute } from '@/app/api/design-studio/library/files/[id]/route'

type Call = { url: string; method: string; headers: Headers; body: any }

const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=lib-1'
const FILE_ID = 'drive-lib-1'
const WEB_LINK = `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`
const MB = 1024 * 1024
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ldp-storage-'))
const created: string[] = []
let calls: Call[] = []
let folderSeq = 0

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function driveMock() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body }
    calls.push(c)
    if (c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST') return new Response(null, { status: 200, headers: { Location: SESSION } })
    if (c.url === SESSION && c.method === 'PUT') {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(c.headers.get('Content-Range') ?? '')!
      if (Number(m[2]) + 1 < Number(m[3])) return new Response(null, { status: 308, headers: { Range: `bytes=0-${m[2]}` } })
      return json({ id: FILE_ID, name: 'x', webViewLink: WEB_LINK })
    }
    if (c.url.includes('alt=media')) return new Response(Buffer.from('psd-from-drive'), { status: 200 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return json({ files: [] })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && c.method === 'POST') return json({ id: `folder-${++folderSeq}` })
    return json({ error: { message: `unexpected ${c.method} ${c.url}` } }, 500)
  }))
}

async function localFile(kind: string, name: string, bytes: Buffer) {
  const rel = `library/${kind.toLowerCase()}/${name}`
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), bytes)
  const row = await prisma.libraryFile.create({ data: { kind, fileName: name, mimeType: kind === 'PSD' ? 'image/vnd.adobe.photoshop' : 'image/png', size: bytes.length, sha256: 'h', storagePath: rel } })
  created.push(row.id)
  return row
}

beforeAll(() => { process.env.DESIGN_STORAGE_DIR = tmp })

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.appSetting.createMany({ data: [
    { key: GOOGLE_KEYS.clientId, value: 'cid' }, { key: GOOGLE_KEYS.clientSecret, value: 'secret' },
    { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' }, { key: GOOGLE_KEYS.rootFolderId, value: 'root-1' },
  ] })
  resetDriveCache()
  primeAccessToken('at-primed', 3600, '1//refresh')
  folderSeq = 0
})

afterEach(() => { vi.unstubAllGlobals() })

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.libraryFile.deleteMany({ where: { id: { in: created } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('pushLibraryFileToDrive', () => {
  it('pushes in chunks into the library folder, does not share publicly, and drops the local copy', async () => {
    const row = await localFile('PSD', 'big.psd', Buffer.alloc(9 * MB, 3))
    driveMock()
    expect(await pushLibraryFileToDrive(row.id, ['Library', 'Store A', 'Tumbler', 'PGprints - Tumbler 20oz'])).toEqual({ pushed: true, warning: null })
    const folders = calls.filter(c => c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id')).map(c => JSON.parse(c.body).name)
    expect(folders).toEqual(['Library', 'Store A', 'Tumbler', 'PGprints - Tumbler 20oz'])
    expect(calls.filter(c => c.method === 'PUT').map(c => c.headers.get('Content-Range'))).toEqual(['bytes 0-8388607/9437184', 'bytes 8388608-9437183/9437184'])
    expect(calls.some(c => c.url.includes('/permissions'))).toBe(false)
    const after = await prisma.libraryFile.findUniqueOrThrow({ where: { id: row.id } })
    expect(after).toMatchObject({ storage: 'DRIVE', driveFileId: FILE_ID, driveWebViewLink: WEB_LINK, storagePath: null })
    expect(fs.existsSync(path.join(tmp, 'library', 'psd', 'big.psd'))).toBe(false)
  })

  it('a DRIVE PSD redirects to Drive, or streams as an attachment with ?download=1', async () => {
    const row = await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'd.psd', mimeType: 'image/vnd.adobe.photoshop', size: 9, sha256: 'h', storage: 'DRIVE', driveFileId: FILE_ID, driveWebViewLink: WEB_LINK } })
    created.push(row.id)
    driveMock()
    const redirect = await serveRoute(new NextRequest('http://localhost/x'), { params: { id: row.id } })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(WEB_LINK)
    const dl = await serveRoute(new NextRequest('http://localhost/x?download=1'), { params: { id: row.id } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toBe('attachment; filename="d.psd"')
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe('psd-from-drive')
  })

  it('serves a local PNG inline', async () => {
    const row = await localFile('PREVIEW', 'p.png', Buffer.from('png'))
    const res = await serveRoute(new NextRequest('http://localhost/x'), { params: { id: row.id } })
    expect(res.headers.get('content-disposition')).toBe('inline; filename="p.png"')
    expect(res.headers.get('content-type')).toBe('image/png')
  })
})
