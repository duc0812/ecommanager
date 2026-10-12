import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { generateWorkerToken } from '@/lib/artwork-worker'
import { syncDesignTasks, loadTask } from '@/lib/design-tasks'
import { buildChecklist } from '@/app/design-studio/components/checklist'
import { POST as claimRoute } from '@/app/api/design-studio/worker/claim/route'
import { GET as workerFile } from '@/app/api/design-studio/worker/files/[id]/route'
import { POST as resultRoute } from '@/app/api/design-studio/worker/jobs/[id]/result/route'
import { POST as failRoute } from '@/app/api/design-studio/worker/jobs/[id]/fail/route'
import { PATCH as patchEntry } from '@/app/api/design-studio/library/entries/[id]/route'
import { POST as autoRender, GET as autoRenderGet } from '@/app/api/design-studio/tasks/[key]/auto-render/route'
import { GET as fileRoute } from '@/app/api/design-studio/file/[artworkId]/route'

const SHOP = 'arnd.myshopify.com'
const PROJECT = 'proj_arnd'
const SUP = 'sup_arnd'
const TPL = 'tpl_arnd'
const P1 = 'gid://shopify/Product/9930001'
const ORDER_ID = 'gid://test/Order/arnd-1'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-print-body')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg')])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arnd-storage-'))

const GRADIENT = {
  type: 'linear', angle: 0, scale: 81, offset: { x: 7.5, y: -78.8 }, align: true, reverse: false, opacity: 1, interpolation: 'perceptual', smoothness: 1,
  stops: [{ pos: 0.011, color: '#a66b24', mid: 0.5 }, { pos: 0.28, color: '#fed98f', mid: 0.66 }, { pos: 1, color: '#fbe6b2', mid: 0.77 }],
}
const BEVEL = {
  technique: 'chiselHard', depth: 396, direction: 'down', size: 3, soften: 1, angle: 30, altitude: 30,
  contour: [[0, 0], [64, 237], [128, 138], [255, 255]],
  highlight: { color: '#ffffff', opacity: 0.74, mode: 'screen' }, shadow: { color: '#b17017', opacity: 0.64, mode: 'multiply' },
}
const field = (x: number) => ({
  field: 'Custom Name', layer: '@Custom Name', sample: 'Harry', font: 'HarryP', sizePx: 308, color: '#fbe8bf', align: 'left',
  box: { x, y: 119, w: 525, h: 311 }, anchor: 'center', tracking: -14, fit: 'shrink', scaleX: 1.1052,
  shadow: { dx: -8.66, dy: 5, blur: 5, color: '#000000', opacity: 1, spread: 20 }, gradient: GRADIENT, bevel: BEVEL,
})

let storeId = ''
let entryId = ''
let token = ''
let userToken = ''
let taskKey = ''

function bearer(url: string, init: ConstructorParameters<typeof NextRequest>[1] = { method: 'POST' }) {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest(url, { ...init, headers })
}

function cookie(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const req = new NextRequest(url, init)
  req.cookies.set(AUTH_COOKIE, userToken)
  return req
}

async function claim(kinds?: string[]) {
  const res = await claimRoute(bearer('http://localhost/api/design-studio/worker/claim', {
    method: 'POST', ...(kinds ? { body: JSON.stringify({ kinds }), headers: { 'Content-Type': 'application/json' } } : {}),
  }))
  return res.json()
}

async function trigger() {
  const res = await autoRender(cookie(`http://localhost/api/design-studio/tasks/${taskKey}/auto-render`, { method: 'POST' }), { params: { key: taskKey } })
  return { status: res.status, body: await res.json() }
}

async function postRender(jobId: string, opts: { print?: Buffer; preview?: Buffer | null } = {}) {
  const fd = new FormData()
  fd.append('print', new Blob([new Uint8Array(opts.print ?? PNG)], { type: 'image/png' }), 'print.png')
  if (opts.preview !== null) fd.append('preview', new Blob([new Uint8Array(opts.preview ?? JPG)], { type: 'image/jpeg' }), 'preview.jpg')
  fd.append('result', new Blob([JSON.stringify({ warnings: ['"Marie-Pier" thu nhỏ còn 49% để vừa khung (Custom Name)'], fields: [] })], { type: 'application/json' }), 'result.json')
  const res = await resultRoute(bearer(`http://localhost/api/design-studio/worker/jobs/${jobId}/result`, { method: 'POST', body: fd }), { params: { id: jobId } })
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.artworkJob.deleteMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'ARND', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'ARND Sup', code: 'ARND' } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, name: 'Tumbler 20oz', widthPx: 3270, heightPx: 1860, dpi: 300, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 3270, h: 1860 }]),
  } })
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: P1, title: 'Tumbler', printTemplateId: TPL } })
  fs.mkdirSync(path.join(tmp, 'library', 'art'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'library', 'art', 'artwork.png'), PNG)
  const psd = await prisma.libraryFile.create({ data: { kind: 'PSD', fileName: 'r.psd', mimeType: 'image/vnd.adobe.photoshop', size: 3, sha256: 'p', storagePath: 'library/art/r.psd' } })
  const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'artwork.png', mimeType: 'image/png', size: PNG.length, sha256: 'artsha', storagePath: 'library/art/artwork.png' } })
  entryId = (await prisma.artworkEntry.create({ data: {
    storeId, shopifyProductId: P1, printTemplateId: TPL, supplierId: SUP, title: 'Tumbler', status: 'READY', psdFileId: psd.id, artworkFileId: art.id,
    fields: JSON.stringify([field(567), field(2141)]), fixedTexts: JSON.stringify([{ name: 'Harry', text: 'Harry', font: 'HarryP' }]), parsedAt: new Date(),
  } })).id
  const fontFile = await prisma.libraryFile.create({ data: { kind: 'FONT', fileName: 'HARRYP_.TTF', mimeType: 'font/ttf', size: 1, sha256: 'fontsha', storagePath: 'library/fonts/h.ttf' } })
  await prisma.designFont.create({ data: { postscriptName: 'HarryP', family: 'HarryP', style: 'Regular', fileId: fontFile.id } })

  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#ARND1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-08'),
    pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [
      { shopifyLineId: 'l1', sku: 'TUMB-20', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1, shopifyProductId: P1,
        resolvedSupplierId: SUP, resolvedSupplierSku: 'UT2-20OZ', customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Custom Name: Yes Or No?', value: 'Yes' }, { key: 'Custom Name', value: 'Marie-Pier' }]) },
    ] },
  } })
  await syncDesignTasks(ORDER_ID)
  taskKey = (await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDER_ID } })).taskKey
  const userId = (await prisma.appUser.create({ data: { name: 'D', email: 'designer@arnd.test', role: 'ADMIN', permissions: JSON.stringify(['design_tasks']) } })).id
  userToken = await signToken({ userId, email: 'designer@arnd.test', name: 'D', role: 'ADMIN', permissions: ['design_tasks'], tv: 0 })
  token = await generateWorkerToken()
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.designFont.deleteMany({ where: { postscriptName: 'HarryP' } })
  await prisma.libraryFile.deleteMany({ where: { sha256: { in: ['p', 'artsha', 'fontsha'] } } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.appUser.deleteMany({ where: { email: 'designer@arnd.test' } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('layerFields', () => {
  it('PATCH stores the mapping, requeues a parse and the claim carries it', async () => {
    const bad = await patchEntry(cookie('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ layerFields: ['Harry'] }) }), { params: { id: entryId } })
    expect(bad.status).toBe(400)
    const res = await patchEntry(cookie('http://localhost/x', {
      method: 'PATCH', body: JSON.stringify({ layerFields: { Harry: 'Custom Name', 'Harry copy': 'Custom Name', Note: '' } }),
    }), { params: { id: entryId } })
    expect(res.status).toBe(200)
    const { entry } = await res.json()
    expect(entry.layerFields).toEqual({ Harry: 'Custom Name', 'Harry copy': 'Custom Name' })
    expect(entry.status).toBe('QUEUED')

    expect((await claim(['RENDER_LINE'])).job).toBeNull()
    const c = await claim()
    expect(c.job.kind).toBe('PARSE_PSD')
    expect(c.entry.layerFields).toEqual({ Harry: 'Custom Name', 'Harry copy': 'Custom Name' })
    await prisma.artworkJob.deleteMany({ where: { entryId } })
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'READY' } })
  })

  it('worker results keep gradient, bevel and per-placement boxes', async () => {
    const { normalizeFields } = await import('@/lib/artwork-fields')
    const [a, b] = normalizeFields([field(567), field(2141)])
    expect(a.gradient).toEqual(GRADIENT)
    expect(a.bevel).toEqual(BEVEL)
    expect([a.box.x, b.box.x]).toEqual([567, 2141])
    expect(() => normalizeFields([{ ...field(1), gradient: { ...GRADIENT, type: 'radial' } }])).toThrow(/linear/)
    expect(() => normalizeFields([{ ...field(1), bevel: { ...BEVEL, highlight: { ...BEVEL.highlight, opacity: 2 } } }])).toThrow(/0–1/)
  })
})

describe('RENDER_LINE', () => {
  it('the task offers the button once the entry is READY and the customer filled the field', async () => {
    const detail = (await loadTask(taskKey))!
    expect(detail.library?.status).toBe('READY')
    expect(detail.autoRender).toBeNull()
    expect(detail.slots).toEqual(['Print'])
    expect(detail.task.readiness).toBe('AUTO')
  })

  it('queues one job per line, claims it with values, fonts and target, and stores an AUTO artwork', async () => {
    const queued = await trigger()
    expect(queued.status).toBe(200)
    expect(queued.body.job.status).toBe('QUEUED')
    expect((await trigger()).status).toBe(409)

    expect((await claim()).job).toBeNull()
    const c = await claim(['PARSE_PSD', 'RENDER_LINE'])
    expect(c.job.kind).toBe('RENDER_LINE')
    expect(c.values).toEqual({ 'Custom Name': 'Marie-Pier' })
    expect(c.entry.fields).toHaveLength(2)
    expect(c.entry.fields[0].gradient.stops).toHaveLength(3)
    expect(c.template).toMatchObject({ widthPx: 3270, heightPx: 1860, dpi: 300 })
    expect(c.fonts).toEqual([{ postscriptName: 'HarryP', fileId: expect.any(String), sha256: 'fontsha' }])
    expect(c.target).toMatchObject({ orderId: ORDER_ID, shopifyLineId: 'l1', orderNumber: '#ARND1', linePosition: 1, taskKey, printArea: 'Print' })
    const file = await workerFile(bearer('http://localhost/x', { method: 'GET' }), { params: { id: c.artwork.id } })
    expect(file.status).toBe(200)
    expect((await autoRenderGet(cookie('http://localhost/x'), { params: { key: taskKey } })).status).toBe(200)

    expect((await postRender(c.job.id, { print: Buffer.from('not a png') })).status).toBe(400)
    const stored = await postRender(c.job.id)
    expect(stored.status).toBe(200)
    const art = await prisma.designArtwork.findUniqueOrThrow({ where: { id: stored.body.artworkId } })
    expect(art).toMatchObject({ orderId: ORDER_ID, shopifyLineId: 'l1', printArea: 'Print', source: 'AUTO', uploadedById: null, storage: 'LOCAL', mimeType: 'image/png' })
    expect(art.previewPath).toMatch(/preview\.jpg$/)
    expect((await postRender(c.job.id)).status).toBe(409)

    const preview = await fileRoute(new NextRequest(`http://localhost/api/design-studio/file/${art.id}?preview=1`), { params: { artworkId: art.id } })
    expect(preview.headers.get('content-type')).toBe('image/jpeg')

    const detail = (await loadTask(taskKey))!
    expect(stored.body.review).toBe(true)
    expect(detail.task.status).toBe('REVIEW')
    expect(detail.task.readiness).toBe('AUTO')
    expect(detail.events.filter(e => e.message === 'Tự động gửi duyệt (file in tự động)')).toHaveLength(1)
    expect(detail.autoRender).toMatchObject({ status: 'DONE', artworkId: art.id })
    expect(detail.line.artworks.find(a => a.id === art.id)).toMatchObject({ source: 'AUTO', previewUrl: `/api/design-studio/file/${art.id}?preview=1` })
    const files = buildChecklist({ ...detail, me: { isLeader: false, canApprove: false } }).items.find(i => i.key === 'files')!
    expect(files.state).toBe('done')
    const events = await prisma.designTaskEvent.findMany({ where: { task: { taskKey } }, orderBy: { createdAt: 'asc' } })
    expect(events.map(e => e.message).join('\n')).toMatch(/Tạo file in tự động Print v1 .*thu nhỏ/)
  })

  it('a failed render shows on the task and frees the button', async () => {
    const queued = await trigger()
    expect(queued.status).toBe(200)
    const c = await claim(['RENDER_LINE'])
    const res = await failRoute(bearer('http://localhost/x', { method: 'POST', body: JSON.stringify({ error: 'Thiếu font HarryP trong thư viện', permanent: true }), headers: { 'Content-Type': 'application/json' } }), { params: { id: c.job.id } })
    expect((await res.json()).jobStatus).toBe('FAILED')
    const detail = (await loadTask(taskKey))!
    expect(detail.autoRender).toMatchObject({ status: 'FAILED', error: 'Thiếu font HarryP trong thư viện' })
    expect((await prisma.artworkEntry.findUniqueOrThrow({ where: { id: entryId } })).status).toBe('READY')
    expect((await prisma.designTaskEvent.findMany({ where: { task: { taskKey } } })).some(e => e.message.includes('Tạo file in tự động lỗi: Thiếu font'))).toBe(true)
  })

  it('a job whose entry stopped being READY fails at claim with a reason', async () => {
    await trigger()
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'NEEDS_REVIEW' } })
    expect((await claim(['RENDER_LINE'])).job).toBeNull()
    const job = await prisma.artworkJob.findFirstOrThrow({ where: { kind: 'RENDER_LINE', orderId: ORDER_ID }, orderBy: { createdAt: 'desc' } })
    expect(job.status).toBe('FAILED')
    expect(job.error).toMatch(/không còn sẵn sàng/)
    expect((await trigger()).status).toBe(409)
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'READY' } })
  })
})

describe('readiness from the artwork library', () => {
  const ORDER2 = 'gid://test/Order/arnd-2'
  afterAll(async () => { await prisma.order.deleteMany({ where: { id: ORDER2 } }) })

  it('is AUTO only while the entry is READY and the customer filled every field', async () => {
    await prisma.order.create({ data: {
      id: ORDER2, projectId: PROJECT, storeId, shopifyOrderNumber: '#ARND2', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-08'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 'm1', sku: 'TUMB-20', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1, shopifyProductId: P1,
          resolvedSupplierId: SUP, resolvedSupplierSku: 'UT2-20OZ', customized: true, customAttributesJson: JSON.stringify([{ key: 'Note', value: 'hi' }]) },
      ] },
    } })
    await syncDesignTasks(ORDER2)
    const readiness = async () => (await prisma.designTask.findFirstOrThrow({ where: { orderId: ORDER2 } })).readiness
    expect(await readiness()).toBe('MANUAL')

    await prisma.orderLine.updateMany({ where: { orderId: ORDER2 }, data: { customAttributesJson: JSON.stringify([{ key: 'custom name', value: 'Ann' }]) } })
    await syncDesignTasks(ORDER2)
    expect(await readiness()).toBe('AUTO')

    await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'NEEDS_REVIEW' } })
    await syncDesignTasks(ORDER2)
    expect(await readiness()).toBe('MANUAL')
    await prisma.artworkEntry.update({ where: { id: entryId }, data: { status: 'READY' } })
  })
})
