import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { canCallApi } from '@/lib/api-access'
import { JOB_STALE_MS, WORKER_TOKEN_KEY, generateWorkerToken } from '@/lib/artwork-worker'
import { requeueEntry } from '@/lib/repos/artwork-library'
import { POST as claimRoute } from '@/app/api/design-studio/worker/claim/route'
import { GET as workerFile } from '@/app/api/design-studio/worker/files/[id]/route'
import { GET as workerFontsRoute } from '@/app/api/design-studio/worker/fonts/route'
import { POST as resultRoute } from '@/app/api/design-studio/worker/jobs/[id]/result/route'
import { POST as failRoute } from '@/app/api/design-studio/worker/jobs/[id]/fail/route'
import { GET as tokenGet, POST as tokenPost, DELETE as tokenDelete } from '@/app/api/design-studio/settings/worker-token/route'

const SHOP = 'awrk.myshopify.com'
const PROJECT = 'proj_awrk'
const SUP = 'sup_awrk'
const TPL = 'tpl_awrk'
const P1 = 'gid://shopify/Product/9920001'
const FONT_PS = 'AwrkScript-Regular'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awrk-storage-'))

let storeId = ''
let entryId = ''
let psdId = ''
let token = ''
let superToken = ''
let adminToken = ''
const fileIds: string[] = []

const FIELD = { field: 'Name', layer: '@Name', sample: 'Anna', font: FONT_PS, sizePx: 96, color: '#ff0000', align: 'center', box: { x: 100, y: 50, w: 800, h: 200 }, anchor: 'center', tracking: 10 }

function bearer(t: string | null, url = 'http://localhost/api/design-studio/worker/claim', init: ConstructorParameters<typeof NextRequest>[1] = { method: 'POST' }) {
  const headers = new Headers(init?.headers)
  if (t !== null) headers.set('Authorization', `Bearer ${t}`)
  return new NextRequest(url, { ...init, headers })
}

async function claim(t = token) {
  const res = await claimRoute(bearer(t))
  return { status: res.status, body: await res.json() }
}

function resultReq(jobId: string, result: unknown, opts: { artwork?: Buffer | null; preview?: Buffer | null; t?: string } = {}) {
  const fd = new FormData()
  if (opts.artwork !== null) fd.append('artwork', new Blob([new Uint8Array(opts.artwork ?? PNG)], { type: 'image/png' }), 'artwork.png')
  if (opts.preview !== null) fd.append('preview', new Blob([new Uint8Array(opts.preview ?? PNG)], { type: 'image/png' }), 'preview.png')
  fd.append('result', new Blob([JSON.stringify(result)], { type: 'application/json' }), 'result.json')
  return bearer(opts.t ?? token, `http://localhost/api/design-studio/worker/jobs/${jobId}/result`, { method: 'POST', body: fd })
}

async function postResult(jobId: string, result: unknown, opts: Parameters<typeof resultReq>[2] = {}) {
  const res = await resultRoute(resultReq(jobId, result, opts), { params: { id: jobId } })
  return { status: res.status, body: await res.json() }
}

async function fail(jobId: string, body: unknown) {
  const res = await failRoute(bearer(token, `http://localhost/x`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), { params: { id: jobId } })
  return { status: res.status, body: await res.json() }
}

function cookieReq(method: string, t: string) {
  const req = new NextRequest('http://localhost/api/design-studio/settings/worker-token', { method })
  req.cookies.set(AUTH_COOKIE, t)
  return req
}

async function freshJob() {
  await prisma.artworkJob.deleteMany({ where: { entry: { storeId } } })
  await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'EMPTY', fields: '[]', missingFonts: '[]', warnings: '[]', checkScore: null, error: null } })
  await requeueEntry(entryId)
  return prisma.artworkJob.findFirstOrThrow({ where: { entryId, status: 'QUEUED' } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.artworkJob.deleteMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'AWRK', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'AWRK Sup', code: 'AWRK' } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, name: 'Mug 11oz', widthPx: 2475, heightPx: 1155, dpi: 300, areas: JSON.stringify([{ name: 'Wrap', x: 0, y: 0, w: 2475, h: 1155 }]),
  } })
  fs.mkdirSync(path.join(tmp, 'library', 'psd'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'library', 'psd', 'w.psd'), Buffer.from('8BPS-worker-psd'))
  const psd = await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'w.psd', mimeType: 'image/vnd.adobe.photoshop', size: 15, sha256: 'abc', storagePath: 'library/psd/w.psd' } })
  psdId = psd.id
  fileIds.push(psd.id)
  entryId = (await prisma.artworkEntry.create({ data: { storeId, shopifyProductId: P1, printTemplateId: TPL, supplierId: SUP, title: 'AWRK Mug', psdFileId: psd.id } })).id

  const superId = (await prisma.appUser.create({ data: { name: 'S', email: 'super@awrk.test', role: 'SUPERADMIN' } })).id
  const adminId = (await prisma.appUser.create({ data: { name: 'A', email: 'admin@awrk.test', role: 'ADMIN', permissions: JSON.stringify(['design_tasks']) } })).id
  superToken = await signToken({ userId: superId, email: 'super@awrk.test', name: 'S', role: 'SUPERADMIN', permissions: [], tv: 0 })
  adminToken = await signToken({ userId: adminId, email: 'admin@awrk.test', name: 'A', role: 'ADMIN', permissions: ['design_tasks'], tv: 0 })
  token = await generateWorkerToken()
})

beforeEach(async () => {
  const row = await prisma.appSetting.findUnique({ where: { key: WORKER_TOKEN_KEY } })
  if (!row) token = await generateWorkerToken()
})

afterAll(async () => {
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.designFont.deleteMany({ where: { postscriptName: FONT_PS } })
  await prisma.libraryFile.deleteMany({ where: { OR: [{ id: { in: fileIds } }, { kind: { in: ['ARTWORK', 'PREVIEW'] }, uploadedById: null, storagePath: { contains: entryId } }] } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['super@awrk.test', 'admin@awrk.test'] } } })
  await prisma.appSetting.deleteMany({ where: { key: WORKER_TOKEN_KEY } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('worker auth', () => {
  it('the worker prefix is public to the middleware; routes check the bearer token', async () => {
    expect(canCallApi(null, [], '/api/design-studio/worker/claim', 'POST')).toBe('ok')
    expect(canCallApi(null, [], '/api/design-studio/library/products', 'GET')).toBe('unauthenticated')
    expect((await claim('')).status).toBe(401)
    expect((await claimRoute(bearer(null))).status).toBe(401)
    expect((await claim('dsw_wrong')).status).toBe(401)
    expect((await workerFontsRoute(bearer('nope', 'http://localhost/x', { method: 'GET' }))).status).toBe(401)
    expect((await workerFile(bearer(null, 'http://localhost/x', { method: 'GET' }), { params: { id: psdId } })).status).toBe(401)
    expect((await failRoute(bearer('nope', 'http://localhost/x', { method: 'POST', body: '{}' }), { params: { id: 'x' } })).status).toBe(401)
    expect((await resultRoute(resultReq('x', {}, { t: 'nope' }), { params: { id: 'x' } })).status).toBe(401)
    expect((await claim()).status).toBe(200)
  })

  it('only a superadmin generates or revokes; the token is shown once and only its hash is stored', async () => {
    expect((await tokenPost(cookieReq('POST', adminToken))).status).toBe(403)
    expect((await tokenDelete(cookieReq('DELETE', adminToken))).status).toBe(403)
    const res = await tokenPost(cookieReq('POST', superToken))
    const body = await res.json()
    expect(body.token).toMatch(/^dsw_/)
    expect(body.configured).toBe(true)
    const stored = await prisma.appSetting.findUniqueOrThrow({ where: { key: WORKER_TOKEN_KEY } })
    expect(stored.value).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.value).not.toContain(body.token)
    expect((await (await tokenGet()).json())).toMatchObject({ configured: true })
    expect((await claim(token)).status).toBe(401)
    token = body.token
    expect((await claim()).status).toBe(200)

    expect((await tokenDelete(cookieReq('DELETE', superToken))).status).toBe(200)
    expect((await claim()).status).toBe(401)
    expect((await (await tokenGet()).json())).toMatchObject({ configured: false })
  })
})

describe('claim', () => {
  it('two concurrent claims never return the same job', async () => {
    const job = await freshJob()
    const [a, b] = await Promise.all([claim(), claim()])
    const got = [a.body.job?.id, b.body.job?.id].filter(Boolean)
    expect(got).toEqual([job.id])
    const winner = a.body.job ? a.body : b.body
    expect(winner).toMatchObject({
      entry: { id: entryId, status: 'PARSING', title: 'AWRK Mug', printTemplateId: TPL, optionKey: '' },
      template: { id: TPL, widthPx: 2475, heightPx: 1155, dpi: 300, areas: [{ name: 'Wrap', x: 0, y: 0, w: 2475, h: 1155 }] },
      psdFileId: psdId, psd: { id: psdId, fileName: 'w.psd', sha256: 'abc' }, job: { id: job.id, attempts: 1 },
    })
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('PARSING')
    expect((await claim()).body).toEqual({ job: null })
  })

  it('reclaims a RUNNING job whose lock is older than 15 minutes', async () => {
    const job = await freshJob()
    expect((await claim()).body.job.id).toBe(job.id)
    expect((await claim()).body.job).toBeNull()
    await prisma.artworkJob.update({ where: { id: job.id }, data: { lockedAt: new Date(Date.now() - JOB_STALE_MS - 1000) } })
    const again = await claim()
    expect(again.body.job).toMatchObject({ id: job.id, attempts: 2 })
  })

  it('a stale job that already used its attempts fails the entry instead of being handed out', async () => {
    const job = await freshJob()
    await prisma.artworkJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 3, lockedAt: new Date(Date.now() - JOB_STALE_MS - 1000) } })
    expect((await claim()).body).toEqual({ job: null })
    expect((await prisma.artworkJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED')
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('ERROR')
  })
})

describe('files and fonts', () => {
  it('downloads the PSD with its hash, serves artwork for renders and refuses other kinds', async () => {
    const res = await workerFile(bearer(token, 'http://localhost/x', { method: 'GET' }), { params: { id: psdId } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-sha256')).toBe('abc')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('8BPS-worker-psd')
    const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'a.png', mimeType: 'image/png', size: 1, sha256: 'z', storagePath: 'library/psd/w.psd' } })
    const prev = await prisma.libraryFile.create({ data: { kind: 'PREVIEW', fileName: 'p.png', mimeType: 'image/png', size: 1, sha256: 'y', storagePath: 'library/psd/w.psd' } })
    fileIds.push(art.id, prev.id)
    expect((await workerFile(bearer(token, 'http://localhost/x', { method: 'GET' }), { params: { id: art.id } })).status).toBe(200) // RENDER_LINE draws on artwork.png
    expect((await workerFile(bearer(token, 'http://localhost/x', { method: 'GET' }), { params: { id: prev.id } })).status).toBe(404)
  })

  it('lists fonts with file id and sha256', async () => {
    const f = await prisma.libraryFile.create({ data: { kind: 'FONT', fileName: 'a.ttf', mimeType: 'font/ttf', size: 3, sha256: 'fonthash' } })
    fileIds.push(f.id)
    await prisma.designFont.create({ data: { postscriptName: FONT_PS, family: 'Awrk Script', style: 'Regular', fileId: f.id } })
    const body = await (await workerFontsRoute(bearer(token, 'http://localhost/x', { method: 'GET' }))).json()
    expect(body.fonts).toContainEqual(expect.objectContaining({ postscriptName: FONT_PS, fileId: f.id, sha256: 'fonthash' }))
  })
})

describe('result', () => {
  it('stores files and fields and sets READY when the check passes', async () => {
    const job = await freshJob()
    await claim()
    const r = await postResult(job.id, { fields: [FIELD], fixedTexts: [{ name: 'Title', text: 'Mom', font: FONT_PS }], missingFonts: [], warnings: [], checkScore: 3.2 })
    expect(r).toMatchObject({ status: 200, body: { ok: true, status: 'READY', entryId } })
    const e = await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId }, include: { artworkFile: true, previewFile: true, jobs: true } })
    expect(e.status).toBe('READY')
    expect(e.checkScore).toBe(3.2)
    expect(JSON.parse(e.fields)).toEqual([{ ...FIELD, fit: 'shrink' }])
    expect(JSON.parse(e.fixedTexts)).toEqual([{ name: 'Title', text: 'Mom', font: FONT_PS }])
    expect(e.artworkFile).toMatchObject({ kind: 'ARTWORK', mimeType: 'image/png', size: PNG.length })
    expect(e.previewFile).toMatchObject({ kind: 'PREVIEW' })
    expect(fs.readFileSync(path.join(tmp, e.artworkFile!.storagePath!)).equals(PNG)).toBe(true)
    expect(e.jobs[0].status).toBe('DONE')
    expect((await postResult(job.id, { fields: [] })).status).toBe(409)
  })

  it('sets NEEDS_FONTS when fonts are missing, NEEDS_REVIEW on a high score or warnings', async () => {
    let job = await freshJob(); await claim()
    expect((await postResult(job.id, { fields: [FIELD], missingFonts: ['Nope-Bold'], warnings: [], checkScore: 1 })).body.status).toBe('NEEDS_FONTS')
    expect(JSON.parse((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).missingFonts)).toEqual(['Nope-Bold'])
    job = await freshJob(); await claim()
    expect((await postResult(job.id, { fields: [FIELD], missingFonts: [], warnings: [], checkScore: 14 })).body.status).toBe('NEEDS_REVIEW')
    job = await freshJob(); await claim()
    expect((await postResult(job.id, { fields: [FIELD], missingFonts: [], warnings: ['Layer @Name dùng warp'], checkScore: 1 })).body.status).toBe('NEEDS_REVIEW')
    job = await freshJob(); await claim()
    expect((await postResult(job.id, { fields: [], fixedTexts: [], missingFonts: [], warnings: ['no @ layers'], checkScore: null })).body.status).toBe('NEEDS_REVIEW')
  })

  it('keeps stretch, per-letter colours, shadow spread and member layers in the stored fields', async () => {
    const job = await freshJob(); await claim()
    const rich = { ...FIELD, scaleX: 1.3, charColors: ['#ff0000', '#00ff00'], layers: ['@Name', '@Name 2'], shadow: { dx: 1, dy: 2, blur: 3, color: '#000000', opacity: 0.6, spread: 4 }, psdInkW: 99 }
    expect((await postResult(job.id, { fields: [rich], checkScore: 2 })).body.status).toBe('READY')
    const [stored] = JSON.parse((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).fields)
    expect(stored).toMatchObject({ scaleX: 1.3, charColors: ['#ff0000', '#00ff00'], layers: ['@Name', '@Name 2'], shadow: { spread: 4 } })
    expect(stored.psdInkW).toBeUndefined()
  })

  it('a reparse keeps the field name, fit and max chars edited in the UI', async () => {
    await freshJob()
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { fields: JSON.stringify([{ ...FIELD, field: 'Customer Name', fit: 'wrap', maxChars: 10 }]) } })
    const job = await prisma.artworkJob.findFirstOrThrow({ where: { entryId, status: 'QUEUED' } })
    await claim()
    await postResult(job.id, { fields: [{ ...FIELD, sizePx: 90 }], checkScore: 2 })
    const fields = JSON.parse((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).fields)
    expect(fields[0]).toMatchObject({ field: 'Customer Name', fit: 'wrap', maxChars: 10, sizePx: 90 })
  })

  it('rejects a bad payload without touching the job', async () => {
    const job = await freshJob(); await claim()
    expect((await postResult(job.id, { fields: [{ ...FIELD, color: 'red' }] })).status).toBe(400)
    expect((await postResult(job.id, { fields: [] }, { artwork: null })).status).toBe(400)
    expect((await postResult(job.id, { fields: [] }, { artwork: Buffer.from('GIF89a') })).status).toBe(400)
    expect((await prisma.artworkJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING')
    expect(fs.existsSync(path.join(tmp, 'tmp')) ? fs.readdirSync(path.join(tmp, 'tmp')) : []).toEqual([])
  })
})

describe('fail', () => {
  it('requeues until the third attempt, then fails the job and the entry', async () => {
    const job = await freshJob()
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await claim()).body.job.attempts).toBe(attempt)
      expect((await fail(job.id, { error: `boom ${attempt}` })).body).toMatchObject({ jobStatus: 'QUEUED', attempts: attempt })
      expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('QUEUED')
    }
    await claim()
    expect((await fail(job.id, { error: 'boom 3' })).body).toMatchObject({ jobStatus: 'FAILED', attempts: 3 })
    const e = await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })
    expect(e).toMatchObject({ status: 'ERROR', error: 'boom 3' })
    expect((await fail(job.id, { error: 'late' })).status).toBe(409)
  })

  it('a permanent failure stops at once', async () => {
    const job = await freshJob()
    await claim()
    expect((await fail(job.id, { error: 'Tỉ lệ PSD lệch template 5%', permanent: true })).body.jobStatus).toBe('FAILED')
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('ERROR')
  })
})
