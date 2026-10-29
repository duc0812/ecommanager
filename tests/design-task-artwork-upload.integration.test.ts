import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { NextRequest } from 'next/server'
// @ts-expect-error Next ships its matcher compiler without types
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { storageRoot } from '@/lib/design-storage'
import { artworkUrl, updateLine } from '@/lib/design-studio'
import { drainDrivePushes, resetDrivePushQueue } from '@/lib/drive-push-queue'
import { config as middlewareConfig } from '@/middleware'
import { PUT as uploadRoute } from '@/app/api/design-studio/tasks/[key]/artwork/route'
import { POST as legacyUpload } from '@/app/api/design-studio/lines/[lineId]/artwork/route'
import { GET as serveRoute } from '@/app/api/design-studio/file/[artworkId]/route'

type Call = { url: string; method: string; headers: Headers; body: any }

const KEYS = Object.values(GOOGLE_KEYS)
const ORDER_ID = 'gid://test/Order/dtu-1'
const SHOP = 'dtu-store.myshopify.com'
const PROJECT = 'proj_dtu'
const TASK = 'DTU1_1'
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=dtu-'
const MB = 1024 * 1024
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtu-storage-'))
const driveLink = (n: string | number) => `https://drive.google.com/file/d/dtu-file-${n}/view?usp=drivesdk`
const FOLDER_LINK = 'https://drive.google.com/drive/folders/folder-4'
let calls: Call[] = []
let designerToken = ''
let outsiderToken = ''
let designerId = ''

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function driveMock(o: { gate?: Promise<void>; put?: () => Response } = {}) {
  calls = []
  let sessions = 0
  let folders = 0
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: RequestInit = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body }
    calls.push(c)
    if (c.url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'at-new', expires_in: 3600 })
    if (c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files') && c.method === 'POST') {
      return new Response(null, { status: 200, headers: { Location: `${SESSION}${++sessions}` } })
    }
    if (c.url.startsWith(SESSION) && c.method === 'PUT') {
      if (o.gate) await o.gate
      if (o.put) return o.put()
      const n = c.url.slice(SESSION.length)
      return json({ id: `dtu-file-${n}`, webViewLink: driveLink(n) })
    }
    if (c.url.includes('/permissions')) return json({ id: 'anyoneWithLink' })
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return json({ files: [] })
    if (c.url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && c.method === 'POST') return json({ id: `folder-${++folders}` })
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

function png(width: number, height: number, padTo = 64): Buffer {
  const head = Buffer.alloc(Math.max(24, padTo), 7)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head
}

function streamOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return }
      controller.enqueue(new Uint8Array(chunks[i++]))
    },
  })
}

type UploadOpts = { key?: string; printArea?: string | null; kind?: string; fileName?: string; type?: string; token?: string | null; headers?: Record<string, string> }

function upload(chunks: Buffer[], o: UploadOpts = {}) {
  const key = o.key ?? TASK
  const qs = new URLSearchParams()
  if (o.printArea !== null) qs.set('printArea', o.printArea ?? 'Front')
  if (o.kind) qs.set('kind', o.kind)
  if (o.fileName !== '') qs.set('fileName', o.fileName ?? 'a.png')
  const headers: Record<string, string> = { ...(o.headers ?? {}) }
  if (o.type !== '') headers['content-type'] = o.type ?? 'image/png'
  const req = new NextRequest(`http://localhost/api/design-studio/tasks/${key}/artwork?${qs}`, {
    method: 'PUT', headers, body: streamOf(chunks), duplex: 'half',
  } as any)
  const token = o.token === undefined ? designerToken : o.token
  if (token) req.cookies.set(AUTH_COOKIE, token)
  return uploadRoute(req, { params: { key } })
}

const rows = () => prisma.designArtwork.findMany({ where: { orderId: ORDER_ID }, orderBy: { createdAt: 'asc' } })
const partFiles = () => (fs.existsSync(path.join(tmp, 'tmp')) ? fs.readdirSync(path.join(tmp, 'tmp')) : [])
const lineRow = () => prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'p1' } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DTU Store', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#DTU1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z'),
      lines: { create: [{ shopifyLineId: 'p1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 }] },
    },
  })
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', taskKey: TASK } })
  designerId = (await prisma.appUser.upsert({
    where: { email: 'designer@dtu.test' }, create: { name: 'Designer', email: 'designer@dtu.test', role: 'SUPPORT', permissions: '["design_tasks"]' }, update: {},
  })).id
  const outsiderId = (await prisma.appUser.upsert({
    where: { email: 'outsider@dtu.test' }, create: { name: 'Outsider', email: 'outsider@dtu.test', role: 'SELLER', permissions: '["overview"]' }, update: {},
  })).id
  designerToken = await signToken({ userId: designerId, email: 'designer@dtu.test', name: 'Designer', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
  outsiderToken = await signToken({ userId: outsiderId, email: 'outsider@dtu.test', name: 'Outsider', role: 'SELLER', permissions: ['overview'], tv: 0 })
})

beforeEach(async () => {
  await drainDrivePushes()
  resetDrivePushQueue()
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.designArtworkUpload.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.designTask.updateMany({ where: { orderId: ORDER_ID }, data: { driveFolderId: null, driveFolderUrl: null, status: 'NEW' } })
  await prisma.orderLine.updateMany({ where: { orderId: ORDER_ID }, data: { designDriveLink: null } })
  await prisma.order.update({ where: { id: ORDER_ID }, data: { designDriveLink: null } })
  fs.rmSync(path.join(tmp, 'design'), { recursive: true, force: true })
  fs.rmSync(path.join(tmp, 'tmp'), { recursive: true, force: true })
  resetDriveCache()
})

afterEach(async () => {
  await drainDrivePushes()
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['designer@dtu.test', 'outsider@dtu.test'] } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('PUT /api/design-studio/tasks/[key]/artwork', () => {
  it('streams the raw body to disk and answers LOCAL before the Drive push, which then flips the artwork to DRIVE', async () => {
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate })
    const chunks = [png(4500, 5400, MB), Buffer.alloc(MB, 1), Buffer.alloc(MB / 2, 2)]
    const bytes = Buffer.concat(chunks)

    const res = await upload(chunks, { fileName: 'Áo đẹp.png' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBeUndefined()
    expect(body.artwork).toMatchObject({
      printArea: 'Front', version: 1, fileName: 'Ao_dep.png', size: bytes.length, mimeType: 'image/png',
      storage: 'LOCAL', driveWebViewLink: null, widthPx: 4500, heightPx: 5400, uploadedById: designerId, source: 'MANUAL',
    })

    const stored = await prisma.designArtwork.findUniqueOrThrow({ where: { id: body.artwork.id } })
    expect(stored).toMatchObject({ storage: 'LOCAL', storagePath: 'design/DTU1/1/Front/v1-Ao_dep.png', driveFileId: null })
    const abs = path.join(storageRoot(), stored.storagePath!)
    expect(fs.readFileSync(abs).equals(bytes)).toBe(true)
    expect(partFiles()).toEqual([])

    release()
    await drainDrivePushes()
    const pushed = await prisma.designArtwork.findUniqueOrThrow({ where: { id: body.artwork.id } })
    expect(pushed).toMatchObject({ storage: 'DRIVE', driveFileId: 'dtu-file-1', driveWebViewLink: driveLink(1), storagePath: null })
    expect(fs.existsSync(abs)).toBe(false)
    const put = calls.find(c => c.method === 'PUT')!
    expect(put.headers.get('Content-Range')).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`)
    expect((put.body as Buffer).equals(bytes)).toBe(true)
    const init = calls.find(c => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Front.png', mimeType: 'image/png', parents: ['folder-4'] })
  })

  it('an approved line that points at the app URL gets the task folder link once the background push lands', async () => {
    await connect()
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    driveMock({ gate })
    const body = await (await upload([png(10, 10)], { printArea: 'Artwork' })).json()
    const line = await lineRow()
    const approved = await updateLine(line.id, { done: true, requiredAreas: ['Artwork'] })
    expect(approved?.line.designDriveLink).toBe(artworkUrl(body.artwork.id))
    await prisma.order.update({ where: { id: ORDER_ID }, data: { designDriveLink: artworkUrl(body.artwork.id) } })

    release()
    await drainDrivePushes()
    expect((await lineRow()).designDriveLink).toBe(FOLDER_LINK)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } })).designDriveLink).toBe(FOLDER_LINK)
  })

  it('without printArea every file name is its own part; the same name and type again is the next version, whatever its case; another type is its own part', async () => {
    driveMock()
    for (const fileName of ['front.png', 'back.png', 'Tay áo trái.png']) expect((await upload([png(1, 1)], { printArea: null, fileName })).status).toBe(200)
    expect((await rows()).map(r => ({ kind: r.kind, part: r.printArea, v: r.version }))).toEqual([
      { kind: 'PRINT', part: 'front', v: 1 }, { kind: 'PRINT', part: 'back', v: 1 }, { kind: 'PRINT', part: 'Tay áo trái', v: 1 },
    ])

    const again = await (await upload([png(2, 2)], { printArea: null, fileName: 'FRONT.PNG' })).json()
    expect(again.artwork).toMatchObject({ kind: 'PRINT', printArea: 'front', version: 2, fileName: 'FRONT.PNG' })
    const psd = await (await upload([Buffer.from('8BPS')], { printArea: null, fileName: 'front.psd', type: '' })).json()
    expect(psd.artwork).toMatchObject({ printArea: 'front.psd', version: 1, mimeType: 'image/vnd.adobe.photoshop' })
    expect((await (await upload([png(1, 1)], { printArea: null, fileName: '.png' })).json()).artwork).toMatchObject({ printArea: 'Artwork', version: 1 })
    const long = await (await upload([png(1, 1)], { printArea: null, fileName: `${'x'.repeat(80)}.png` })).json()
    expect(long.artwork.printArea).toBe('x'.repeat(60))
    expect(await rows()).toHaveLength(7)
  })

  it('a mockup is a file of its own kind: the same name as a print file does not collide, and only images are taken', async () => {
    driveMock()
    const print = await (await upload([png(1, 1)], { printArea: null, fileName: 'front.png' })).json()
    const mock = await (await upload([png(3, 3)], { printArea: null, fileName: 'front.png', kind: 'MOCKUP' })).json()
    expect(print.artwork).toMatchObject({ kind: 'PRINT', printArea: 'front', version: 1 })
    expect(mock.artwork).toMatchObject({ kind: 'MOCKUP', printArea: 'front', version: 1 })
    const stored = await rows()
    expect(stored.map(r => r.storagePath)).toEqual(['design/DTU1/1/front/v1-front.png', 'design/DTU1/1/_mockup/front/v1-front.png'])
    const second = await (await upload([png(3, 3)], { printArea: null, fileName: 'Front.png', kind: 'MOCKUP' })).json()
    expect(second.artwork).toMatchObject({ kind: 'MOCKUP', printArea: 'front', version: 2 })

    const pdf = await upload([Buffer.from('%PDF')], { printArea: null, fileName: 'mock.pdf', type: 'application/pdf', kind: 'MOCKUP' })
    expect(pdf.status).toBe(400)
    expect((await pdf.json()).error).toMatch(/Mockup chỉ nhận ảnh PNG hoặc JPG/)
    expect((await upload([png(1, 1)], { kind: 'SOURCE' })).status).toBe(400)
    expect(await rows()).toHaveLength(3)
  })

  it('keeps the file on the server without calling Google while Drive is not connected', async () => {
    driveMock()
    const res = await upload([png(1, 1)])
    expect(res.status).toBe(200)
    await drainDrivePushes()
    expect(calls).toHaveLength(0)
    expect((await rows())[0]).toMatchObject({ storage: 'LOCAL', version: 1 })
  })

  it('a failed background push leaves the artwork on the server and rejects nothing', async () => {
    await connect()
    driveMock({ put: () => json({ error: { message: 'Backend Error' } }, 503) })
    const res = await upload([Buffer.from('keep-me')], { fileName: 'k.pdf', type: 'application/pdf' })
    expect(res.status).toBe(200)
    await drainDrivePushes()
    const row = (await rows())[0]
    expect(row).toMatchObject({ storage: 'LOCAL', mimeType: 'application/pdf', driveFileId: null })
    expect(fs.readFileSync(path.join(storageRoot(), row.storagePath!), 'utf8')).toBe('keep-me')
    expect(global.__drivePushQueue!.uploadError?.message).toMatch(/Backend Error/)
  })

  it('stops a body that runs past 200 MB, whatever it declared, and leaves nothing behind', async () => {
    driveMock()
    const chunk = Buffer.alloc(MB)
    const res = await upload(Array.from({ length: 201 }, () => chunk))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('File lớn hơn 200 MB')
    expect(await rows()).toHaveLength(0)
    expect(partFiles()).toEqual([])

    const declared = await upload([Buffer.from('x')], { headers: { 'content-length': String(201 * MB) } })
    expect(declared.status).toBe(413)
    expect(await rows()).toHaveLength(0)
  }, 60_000)

  it('trusts the file type only through the extension allow-list', async () => {
    driveMock()
    const exe = await upload([Buffer.from('MZ')], { fileName: 'virus.exe', type: 'image/png' })
    expect(exe.status).toBe(400)
    expect((await exe.json()).error).toMatch(/Chỉ nhận PNG, JPG, PDF, PSD, ZIP, TIF/)
    expect((await upload([Buffer.from('x')], { fileName: 'page.html', type: 'text/html' })).status).toBe(400)
    expect((await upload([Buffer.from('x')], { fileName: 'noext', type: '' })).status).toBe(400)
    expect((await upload([Buffer.from('x')], { fileName: '' })).status).toBe(400)
    expect((await upload([], { fileName: 'empty.png' })).status).toBe(400)
    expect(await rows()).toHaveLength(0)

    const cases: Array<[string, string, string]> = [
      ['a.png', 'text/html', 'image/png'],
      ['scan.TIF', 'application/octet-stream', 'image/tiff'],
      ['scan.tiff', 'image/tiff', 'image/tiff'],
      ['layers.psd', '', 'image/vnd.adobe.photoshop'],
      ['bundle.zip', 'application/x-zip-compressed', 'application/zip'],
      ['photo.jpeg', 'image/jpeg', 'image/jpeg'],
      ['noext', 'image/jpeg; charset=binary', 'image/jpeg'],
    ]
    for (const [fileName, type, mime] of cases) {
      const res = await upload([Buffer.from('data')], { fileName, type, printArea: 'Types' })
      expect(res.status, fileName).toBe(200)
      expect((await res.json()).artwork.mimeType, fileName).toBe(mime)
    }
    expect((await rows()).map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(partFiles()).toEqual([])
  })

  it('finds the line by task key after an order sync recreated the OrderLine rows', async () => {
    driveMock()
    const before = await lineRow()
    await prisma.orderLine.delete({ where: { id: before.id } })
    const after = await prisma.orderLine.create({
      data: { orderId: ORDER_ID, shopifyLineId: 'p1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 },
    })
    expect(after.id).not.toBe(before.id)

    const fd = new FormData()
    fd.set('printArea', 'Front')
    fd.set('file', new Blob([new Uint8Array(png(1, 1))], { type: 'image/png' }), 'old.png')
    const legacy = await legacyUpload(new NextRequest(`http://localhost/api/design-studio/lines/${before.id}/artwork`, { method: 'POST', body: fd }), { params: { lineId: before.id } })
    expect(legacy.status).toBe(404)

    const res = await upload([png(2, 3)], { fileName: 'new.png' })
    expect(res.status).toBe(200)
    expect(await rows()).toMatchObject([{ orderId: ORDER_ID, shopifyLineId: 'p1', printArea: 'Front', version: 1, fileName: 'new.png', widthPx: 2, heightPx: 3 }])
  })

  it('answers 404 for an unknown task and 409 while the line row is missing', async () => {
    driveMock()
    expect((await upload([png(1, 1)], { key: 'NOPE_9' })).status).toBe(404)
    const line = await lineRow()
    await prisma.orderLine.delete({ where: { id: line.id } })
    try {
      const res = await upload([png(1, 1)])
      expect(res.status).toBe(409)
      expect(await rows()).toHaveLength(0)
    } finally {
      await prisma.orderLine.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', sku: 'S', productTitle: 'Shirt', qty: 1, linePosition: 1, unitPrice: 1 } })
    }
  })

  it('checks access inside the route, because the middleware does not run for this path', async () => {
    driveMock()
    expect((await upload([png(1, 1)], { token: null })).status).toBe(401)
    expect((await upload([png(1, 1)], { token: outsiderToken })).status).toBe(403)
    expect(await rows()).toHaveLength(0)

    const matcher = pathToRegexp(middlewareConfig.matcher[0])
    expect(matcher.test('/api/design-studio/tasks/LIT4545_1/artwork')).toBe(false)
    expect(matcher.test('/api/design-studio/library/entries/upload')).toBe(false)
    expect(matcher.test('/api/design-studio/tasks/LIT4545_1')).toBe(true)
    expect(matcher.test('/api/design-studio/tasks/LIT4545_1/transition')).toBe(true)
    expect(matcher.test('/api/design-studio/tasks/LIT4545_1/auto-render')).toBe(true)
    expect(matcher.test('/api/design-studio/lines/abc/artwork')).toBe(true)
    expect(matcher.test('/design-studio')).toBe(true)
  })
})

describe('TIFF is served like PSD/ZIP', () => {
  it('a TIFF on Drive redirects to the Drive page instead of streaming into an <img>', async () => {
    const art = await prisma.designArtwork.create({
      data: {
        orderId: ORDER_ID, shopifyLineId: 'p1', printArea: 'Front', version: 1, fileName: 'scan.tif', size: 9, mimeType: 'image/tiff',
        storage: 'DRIVE', driveFileId: 'dtu-file-9', driveWebViewLink: driveLink(9), storagePath: null,
      },
    })
    driveMock()
    const res = await serveRoute(new NextRequest('http://localhost/x'), { params: { artworkId: art.id } })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(driveLink(9))
    expect(calls).toHaveLength(0)
  })
})

describe('files left over from before the template', () => {
  const ORDER2 = 'gid://test/Order/dtu-2'
  const SUP = 'sup_dtu'
  const files2 = () => prisma.designArtwork.findMany({ where: { orderId: ORDER2 }, orderBy: { createdAt: 'asc' } })

  beforeAll(async () => {
    await prisma.supplier.upsert({ where: { code: 'DTUSUP' }, create: { id: SUP, name: 'DTU Supplier', code: 'DTUSUP' }, update: {} })
    await prisma.printTemplate.create({
      data: { supplierId: SUP, supplierSku: 'DTU-SHEET', name: 'Sheet', widthPx: 100, heightPx: 50, areas: JSON.stringify([{ name: 'FRONT', x: 0, y: 0, w: 100, h: 50 }]) },
    })
    const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
    await prisma.order.create({
      data: {
        id: ORDER2, projectId: PROJECT, storeId, shopifyOrderNumber: '#DTU2', financialStatus: 'PAID', currency: 'USD',
        grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-05T12:00:00Z'),
        lines: { create: [{ shopifyLineId: 'p1', sku: 'S', productTitle: 'Hoodie', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, resolvedSupplierSku: 'DTU-SHEET' }] },
      },
    })
    await prisma.designTask.create({ data: { orderId: ORDER2, shopifyLineId: 'p1', taskKey: 'DTU2_1' } })
  })

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: ORDER2 } })
    await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
    await prisma.supplier.deleteMany({ where: { id: SUP } })
  })

  it('a file in a template area retires the parts uploaded before it; a part added later stays', async () => {
    for (const name of ['DTU2_1 - front.png', 'DTU2_1 - back.png']) {
      expect((await upload([png(40, 30)], { key: 'DTU2_1', printArea: null, fileName: name })).status).toBe(200)
    }
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER2 }, data: { createdAt: new Date('2026-10-24T00:00:00Z') } })
    expect((await files2()).map(f => f.printArea).sort()).toEqual(['DTU2_1 - back', 'DTU2_1 - front'])

    expect((await upload([png(100, 50)], { key: 'DTU2_1', printArea: 'FRONT', fileName: 'sheet.png' })).status).toBe(200)
    const after = await files2()
    expect(after.filter(f => !f.removedAt).map(f => f.printArea)).toEqual(['FRONT'])
    expect(after.filter(f => f.removedAt).every(f => f.removedById === designerId)).toBe(true)
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DTU2_1' } })
    const events = await prisma.designTaskEvent.findMany({ where: { taskId: task.id, message: { contains: '_old' } } })
    expect(events).toHaveLength(1)

    expect((await upload([png(40, 30)], { key: 'DTU2_1', printArea: null, fileName: 'reference.png' })).status).toBe(200)
    expect((await upload([png(100, 50)], { key: 'DTU2_1', printArea: 'FRONT', fileName: 'sheet.png' })).status).toBe(200)
    expect((await files2()).filter(f => !f.removedAt).map(f => `${f.printArea} v${f.version}`).sort()).toEqual(['FRONT v1', 'FRONT v2', 'reference v1'])
  })
})
