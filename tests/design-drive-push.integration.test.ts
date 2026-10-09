import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { saveArtwork, storageRoot } from '@/lib/design-storage'
import { updateLine } from '@/lib/design-studio'
import { transitionTask } from '@/lib/design-tasks'
import { POST as uploadRoute } from '@/app/api/design-studio/lines/[lineId]/artwork/route'
import { POST as pushRoute } from '@/app/api/design-studio/artwork/[artworkId]/push/route'
import { GET as serveRoute } from '@/app/api/design-studio/file/[artworkId]/route'

type Call = { url: string; method: string; headers: Headers; body: any }

const KEYS = Object.values(GOOGLE_KEYS)
const ORDER_ID = 'gid://test/Order/ddp-1'
const SHOP = 'ddp-store.myshopify.com'
const PROJECT = 'proj_ddp'
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=sess-1'
const FILE_ID = 'drive-file-1'
const WEB_LINK = `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`
const MB = 1024 * 1024
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddp-storage-'))
let lineId = ''
let calls: Call[] = []
let folderSeq = 0

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

type Overrides = { put?: (c: Call) => Response | null; share?: () => Response; media?: () => Response; token?: () => Response }

function driveMock(o: Overrides = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body }
    calls.push(c)
    if (c.url === 'https://oauth2.googleapis.com/token') return o.token ? o.token() : json({ access_token: 'at-new', expires_in: 3600 })
    if (c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST') {
      return new Response(null, { status: 200, headers: { Location: SESSION } })
    }
    if (c.url === SESSION && c.method === 'PUT') {
      const custom = o.put?.(c)
      if (custom) return custom
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(c.headers.get('Content-Range') ?? '')!
      const end = Number(m[2]), total = Number(m[3])
      if (end + 1 < total) return new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } })
      return json({ id: FILE_ID, name: 'x', webViewLink: WEB_LINK })
    }
    if (c.url.includes(`/files/${FILE_ID}/permissions`)) return o.share ? o.share() : json({ id: 'anyoneWithLink' })
    if (c.url.includes('alt=media')) return o.media ? o.media() : new Response(Buffer.from('png-bytes'), { status: 200 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files') && c.method === 'DELETE') return new Response(null, { status: 204 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return json({ files: [] })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && c.method === 'POST') return json({ id: `folder-${++folderSeq}` })
    return json({ error: { message: `unexpected ${c.method} ${c.url}` } }, 500)
  }))
}

async function connect() {
  await prisma.appSetting.createMany({
    data: [
      { key: GOOGLE_KEYS.clientId, value: 'cid' },
      { key: GOOGLE_KEYS.clientSecret, value: 'secret' },
      { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' },
      { key: GOOGLE_KEYS.rootFolderId, value: 'root-1' },
    ],
  })
  primeAccessToken('at-primed', 3600, '1//refresh')
}

function uploadReq(printArea: string, bytes: Buffer, name: string, type: string) {
  const fd = new FormData()
  fd.set('printArea', printArea)
  fd.set('file', new Blob([new Uint8Array(bytes)], { type }), name)
  return new NextRequest(`http://localhost/api/design-studio/lines/${lineId}/artwork`, { method: 'POST', body: fd })
}

function localFile(storagePath: string) {
  return path.join(storageRoot(), storagePath)
}

async function driveArtwork(printArea: string, fileName: string, mimeType: string) {
  return prisma.designArtwork.create({
    data: {
      orderId: ORDER_ID, shopifyLineId: 'p1', printArea, version: 1, fileName, size: 9, mimeType,
      storage: 'DRIVE', driveFileId: FILE_ID, driveWebViewLink: WEB_LINK, storagePath: null,
    },
  })
}

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DDP Store', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  const o = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#DDP1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z'),
      lines: { create: [{ shopifyLineId: 'p1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 }] },
    },
    include: { lines: true },
  })
  lineId = o.lines[0].id
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', taskKey: 'DDP1_1-task' } })
})

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.designArtworkUpload.deleteMany({ where: { orderId: ORDER_ID } })
  fs.rmSync(path.join(tmp, 'design'), { recursive: true, force: true })
  resetDriveCache()
  folderSeq = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('upload route pushes to Drive', () => {
  it('pushes a 20 MB file as 3 chunk PUTs, shares it, converts the row to DRIVE and deletes the local file', async () => {
    await connect()
    driveMock()
    const bytes = Buffer.alloc(20 * MB, 7)
    const res = await uploadRoute(uploadReq('Front', bytes, 'big.png', 'image/png'), { params: { lineId } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBeUndefined()
    expect(body.artwork).toMatchObject({ storage: 'DRIVE', driveWebViewLink: WEB_LINK, version: 1, printArea: 'Front' })

    const folders = calls.filter(c => c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id')).map(c => JSON.parse(c.body))
    expect(folders.map(f => f.name)).toEqual(['DDP Store', '2026-10', '#DDP1', 'DDP1_1-task'])

    const init = calls.find(c => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!
    expect(JSON.parse(init.body)).toMatchObject({ name: 'v1-big.png', mimeType: 'image/png', parents: ['folder-4'] })
    expect(init.headers.get('X-Upload-Content-Length')).toBe(String(20 * MB))

    const puts = calls.filter(c => c.method === 'PUT')
    expect(puts.map(c => c.headers.get('Content-Range'))).toEqual([
      'bytes 0-8388607/20971520',
      'bytes 8388608-16777215/20971520',
      'bytes 16777216-20971519/20971520',
    ])
    expect(puts.map(c => (c.body as Buffer).length)).toEqual([8 * MB, 8 * MB, 4 * MB])
    expect(calls.some(c => c.url.includes(`/files/${FILE_ID}/permissions`) && JSON.parse(c.body).type === 'anyone')).toBe(true)

    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: body.artwork.id } })
    expect(row).toMatchObject({ storage: 'DRIVE', driveFileId: FILE_ID, driveWebViewLink: WEB_LINK, storagePath: null })
    expect(fs.existsSync(path.join(storageRoot(), 'design', 'DDP1', '1', 'Front', 'v1-big.png'))).toBe(false)
    const upload = await prisma.designArtworkUpload.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(upload.completedAt).not.toBeNull()
    expect(upload.driveFileId).toBe(FILE_ID)
    expect(upload.sessionUrl).toBe(SESSION)
  })

  it('keeps the local path with no warning when Drive is not connected', async () => {
    driveMock()
    const res = await uploadRoute(uploadReq('Front', Buffer.from('abc'), 'a.png', 'image/png'), { params: { lineId } })
    const body = await res.json()
    expect(body.warning).toBeUndefined()
    expect(body.artwork.storage).toBe('LOCAL')
    expect(calls).toHaveLength(0)
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: body.artwork.id } })
    expect(fs.readFileSync(localFile(row.storagePath!), 'utf8')).toBe('abc')
  })

  it('falls back to LOCAL with the file and a warning when a chunk PUT fails', async () => {
    await connect()
    driveMock({ put: () => json({ error: { message: 'Backend Error' } }, 503) })
    const res = await uploadRoute(uploadReq('Front', Buffer.from('keep-me'), 'a.png', 'image/png'), { params: { lineId } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toMatch(/^Chưa đẩy được lên Drive: .*Backend Error/)
    expect(body.artwork.storage).toBe('LOCAL')
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: body.artwork.id } })
    expect(row.storage).toBe('LOCAL')
    expect(row.driveFileId).toBeNull()
    expect(fs.readFileSync(localFile(row.storagePath!), 'utf8')).toBe('keep-me')
    const upload = await prisma.designArtworkUpload.findFirstOrThrow({ where: { orderId: ORDER_ID } })
    expect(upload.completedAt).toBeNull()
  })

  it('removes the orphan Drive file when sharing fails and stays LOCAL', async () => {
    await connect()
    driveMock({ share: () => json({ error: { message: 'Sharing disabled' } }, 403) })
    const res = await uploadRoute(uploadReq('Front', Buffer.from('x'), 'a.png', 'image/png'), { params: { lineId } })
    const body = await res.json()
    expect(body.warning).toMatch(/Sharing disabled/)
    expect(body.artwork.storage).toBe('LOCAL')
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes(`/files/${FILE_ID}`))).toBe(true)
  })

  it('says Drive needs reconnecting when the refresh token is revoked', async () => {
    await connect()
    resetDriveCache()
    driveMock({ token: () => json({ error: 'invalid_grant' }, 400) })
    const res = await uploadRoute(uploadReq('Front', Buffer.from('x'), 'a.png', 'image/png'), { params: { lineId } })
    const body = await res.json()
    expect(body.warning).toBe('Google Drive cần kết nối lại')
    expect(body.artwork.storage).toBe('LOCAL')
  })
})

describe('POST /api/design-studio/artwork/[artworkId]/push', () => {
  it('converts a LOCAL artwork to DRIVE and refuses a second push', async () => {
    const saved = await saveArtwork({ lineId, printArea: 'Back', fileName: 'b.png', mimeType: 'image/png', bytes: Buffer.from('later'), uploadedById: null })
    const before = await prisma.designArtwork.findUniqueOrThrow({ where: { id: saved.id } })
    await connect()
    driveMock()

    const res = await pushRoute(new NextRequest(`http://localhost/api/design-studio/artwork/${saved.id}/push`, { method: 'POST' }), { params: { artworkId: saved.id } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.artwork).toMatchObject({ id: saved.id, version: before.version, storage: 'DRIVE', driveWebViewLink: WEB_LINK })
    expect(fs.existsSync(localFile(before.storagePath!))).toBe(false)

    const again = await pushRoute(new NextRequest('http://localhost/x', { method: 'POST' }), { params: { artworkId: saved.id } })
    expect(again.status).toBe(400)
  })

  it('refuses a LOCAL artwork whose file is gone', async () => {
    const saved = await saveArtwork({ lineId, printArea: 'Gone', fileName: 'g.png', mimeType: 'image/png', bytes: Buffer.from('x'), uploadedById: null })
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: saved.id } })
    fs.rmSync(localFile(row.storagePath!))
    await connect()
    driveMock()
    const res = await pushRoute(new NextRequest('http://localhost/x', { method: 'POST' }), { params: { artworkId: saved.id } })
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('returns 502 with the warning when the retry fails, keeping the file', async () => {
    const saved = await saveArtwork({ lineId, printArea: 'Retry', fileName: 'r.png', mimeType: 'image/png', bytes: Buffer.from('x'), uploadedById: null })
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: saved.id } })
    await connect()
    driveMock({ put: () => json({ error: { message: 'Quota' } }, 403) })
    const res = await pushRoute(new NextRequest('http://localhost/x', { method: 'POST' }), { params: { artworkId: saved.id } })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Chưa đẩy được lên Drive: .*Quota/)
    expect(fs.existsSync(localFile(row.storagePath!))).toBe(true)
  })
})

describe('GET /api/design-studio/file/[artworkId] for DRIVE', () => {
  it('streams a PNG from Drive with the stored mime', async () => {
    const art = await driveArtwork('Front', 'a.png', 'image/png')
    await connect()
    driveMock({ media: () => new Response(Buffer.from('png-bytes'), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) })
    const res = await serveRoute(new NextRequest(`http://localhost/api/design-studio/file/${art.id}`), { params: { artworkId: art.id } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="a.png"')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png-bytes')
    const media = calls.find(c => c.url.includes('alt=media'))!
    expect(media.url).toBe(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`)
  })

  it('redirects a PSD to the Drive web link', async () => {
    const art = await driveArtwork('Front', 'a.psd', 'image/vnd.adobe.photoshop')
    await connect()
    driveMock()
    const res = await serveRoute(new NextRequest('http://localhost/x'), { params: { artworkId: art.id } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(WEB_LINK)
    expect(calls).toHaveLength(0)
  })

  it('returns 502 when Drive needs reconnecting', async () => {
    const art = await driveArtwork('Front', 'a.png', 'image/png')
    await connect()
    resetDriveCache()
    driveMock({ token: () => json({ error: 'invalid_grant' }, 400) })
    const res = await serveRoute(new NextRequest('http://localhost/x'), { params: { artworkId: art.id } })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBeTruthy()
  })
})

describe('updateLine with a DRIVE artwork', () => {
  it('stores the Drive web link as the design link', async () => {
    await driveArtwork('Artwork', 'final.png', 'image/png')
    const r = await updateLine(lineId, { done: true, requiredAreas: ['Artwork'] })
    expect(r?.line.designDriveLink).toBe(WEB_LINK)
    await updateLine(lineId, { done: false })
  })

  it('approving again replaces the task own earlier Drive link instead of treating it as an outside design', async () => {
    await driveArtwork('Artwork', 'v1.png', 'image/png')
    const v2Link = 'https://drive.google.com/file/d/drive-file-2/view?usp=drivesdk'
    await prisma.designArtwork.create({
      data: {
        orderId: ORDER_ID, shopifyLineId: 'p1', printArea: 'Artwork', version: 2, fileName: 'v2.png', size: 9, mimeType: 'image/png',
        storage: 'DRIVE', driveFileId: 'drive-file-2', driveWebViewLink: v2Link,
      },
    })
    await prisma.orderLine.update({ where: { id: lineId }, data: { designDriveLink: WEB_LINK } })
    await prisma.designTask.update({ where: { taskKey: 'DDP1_1-task' }, data: { status: 'REVIEW' } })

    await transitionTask('DDP1_1-task', { id: 'leader-1', name: 'Leader', role: 'ADMIN' }, { to: 'DONE' })
    const line = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })
    expect(line.designDriveLink).toBe(v2Link)
    await prisma.orderLine.update({ where: { id: lineId }, data: { designDriveLink: null } })
  })
})
