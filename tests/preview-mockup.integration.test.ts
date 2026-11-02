import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import { prisma } from '@/lib/db'
import { syncDesignTasks } from '@/lib/design-tasks'
import { isPreviewCdnUrl, previewAsJpeg, savePreviewMockups } from '@/lib/preview-mockup'

const pushed = vi.hoisted(() => [] as string[])
vi.mock('@/lib/drive-push-queue', () => ({ enqueueDrivePush: (id: string) => { pushed.push(id) } }))

const ORDER_ID = 'gid://test/Order/pvm-1'
const SHOP = 'pvm-store.myshopify.com'
const PROJECT = 'proj_pvm'
const LINE = 'pvm-line-1'
const URL_OK = 'https://assets-v2.customall.io/abc.png'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-storage-'))
let jpeg: Buffer
let webp: Buffer

function image(bytes: Buffer) {
  return vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
}

async function reset(opts: { url?: string | null; status?: string; link?: string | null } = {}) {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#PVM1', financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
      totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-01'),
      lines: { create: [{ shopifyLineId: LINE, sku: 'S', productTitle: 'Tee', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: 'sup-pvm', previewCdnUrl: opts.url === undefined ? URL_OK : opts.url, designDriveLink: opts.link ?? null }] },
    },
  })
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: LINE, taskKey: 'PVM1_1', status: opts.status ?? 'NEW', readiness: 'LOW', kpi: 1, slaHours: 24 } })
  pushed.length = 0
}

const mockups = () => prisma.designArtwork.findMany({ where: { orderId: ORDER_ID, kind: 'MOCKUP' } })

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'PVM', startDate: new Date('2026-01-01') }, update: {} })
  await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })
  jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#336699' } }).jpeg().toBuffer()
  webp = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer()
})

beforeEach(() => { vi.unstubAllGlobals() })

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('isPreviewCdnUrl', () => {
  it('takes only https links on the personaliser CDN', () => {
    expect(isPreviewCdnUrl(URL_OK)).toBe(true)
    expect(isPreviewCdnUrl('https://cdn.customall.io/x.png')).toBe(true)
    expect(isPreviewCdnUrl('http://assets-v2.customall.io/x.png')).toBe(false)
    expect(isPreviewCdnUrl('https://customall.io.evil.test/x.png')).toBe(false)
    expect(isPreviewCdnUrl('https://169.254.169.254/latest')).toBe(false)
    expect(isPreviewCdnUrl('not a url')).toBe(false)
  })
})

describe('previewAsJpeg', () => {
  it('keeps a JPEG byte for byte and re-encodes WebP over white', async () => {
    expect((await previewAsJpeg(jpeg)).equals(jpeg)).toBe(true)
    const out = await previewAsJpeg(webp)
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeGreaterThan(250)
  })
  it('rejects bytes that are no image', async () => {
    await expect(previewAsJpeg(Buffer.from('<html>nope</html>'))).rejects.toThrow()
  })
})

describe('savePreviewMockups', () => {
  it('stores the preview as an auto mockup, queues the Drive push, logs it and leaves the task status', async () => {
    await reset()
    vi.stubGlobal('fetch', image(webp))
    expect(await savePreviewMockups(ORDER_ID)).toEqual({ saved: 1, errors: [] })
    const [m] = await mockups()
    expect(m).toMatchObject({ printArea: 'Preview', fileName: 'Preview.jpg', mimeType: 'image/jpeg', source: 'AUTO', kind: 'MOCKUP', version: 1, uploadedById: null })
    expect(pushed).toEqual([m.id])
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'PVM1_1' }, include: { events: true } })
    expect(task.status).toBe('NEW')
    expect(task.events.map(e => e.type)).toEqual(['ARTWORK'])
  })

  it('runs once: a second sync fetches nothing', async () => {
    await reset()
    vi.stubGlobal('fetch', image(jpeg))
    await savePreviewMockups(ORDER_ID)
    const again = image(jpeg)
    vi.stubGlobal('fetch', again)
    expect(await savePreviewMockups(ORDER_ID)).toEqual({ saved: 0, errors: [] })
    expect(again).not.toHaveBeenCalled()
  })

  it('does not bring back a mockup a person removed', async () => {
    await reset()
    vi.stubGlobal('fetch', image(jpeg))
    await savePreviewMockups(ORDER_ID)
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER_ID }, data: { removedAt: new Date() } })
    expect((await savePreviewMockups(ORDER_ID)).saved).toBe(0)
    expect(await mockups()).toHaveLength(1)
  })

  it.each(['DONE', 'CANCELLED'])('leaves a %s task alone', async status => {
    await reset({ status })
    const f = image(jpeg)
    vi.stubGlobal('fetch', f)
    expect((await savePreviewMockups(ORDER_ID)).saved).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('never fetches a link off the CDN', async () => {
    await reset({ url: 'https://169.254.169.254/latest/meta-data' })
    const f = image(jpeg)
    vi.stubGlobal('fetch', f)
    expect(await savePreviewMockups(ORDER_ID)).toEqual({ saved: 0, errors: [] })
    expect(f).not.toHaveBeenCalled()
  })

  it('does not follow a redirect', async () => {
    await reset()
    const f = image(jpeg)
    vi.stubGlobal('fetch', f)
    await savePreviewMockups(ORDER_ID)
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' })
  })

  it('reports a failed download, stores nothing and tries again next time', async () => {
    await reset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    const r = await savePreviewMockups(ORDER_ID)
    expect(r.saved).toBe(0)
    expect(r.errors[0]).toContain('HTTP 404')
    expect(await mockups()).toHaveLength(0)
    vi.stubGlobal('fetch', image(jpeg))
    expect((await savePreviewMockups(ORDER_ID)).saved).toBe(1)
  })

  it('an auto mockup does not stop a library link from completing the task', async () => {
    await reset({ link: 'https://drive.google.com/file/d/lib/view' })
    vi.stubGlobal('fetch', image(jpeg))
    await savePreviewMockups(ORDER_ID)
    expect((await syncDesignTasks(ORDER_ID)).completed).toBe(1)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'PVM1_1' } })).status).toBe('DONE')
  })

  it('a mockup a person uploaded still marks the line as worked on', async () => {
    await reset({ link: 'https://drive.google.com/file/d/lib/view' })
    vi.stubGlobal('fetch', image(jpeg))
    await savePreviewMockups(ORDER_ID)
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER_ID }, data: { source: 'MANUAL' } })
    expect((await syncDesignTasks(ORDER_ID)).completed).toBe(0)
  })
})
