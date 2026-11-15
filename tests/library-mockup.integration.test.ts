import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import { prisma } from '@/lib/db'
import { saveArtwork, localArtworkPath } from '@/lib/design-storage'
import { LIBRARY_MOCKUP_PART, saveLibraryMockups } from '@/lib/library-mockup'

const pushed = vi.hoisted(() => [] as string[])
vi.mock('@/lib/drive-push-queue', () => ({ enqueueDrivePush: (id: string) => { pushed.push(id) } }))

const SHOP = 'lbm-store.myshopify.com'
const PROJECT = 'proj_lbm'
const SUP = 'sup-lbm'
const SKU = 'LBM-HOODIE-XL'
const TARGET = 'gid://test/Order/lbm-target'
const SRC_OLD = 'gid://test/Order/lbm-src-old'
const SRC_NEW = 'gid://test/Order/lbm-src-new'
const ORDERS = [TARGET, SRC_OLD, SRC_NEW]
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lbm-storage-'))
let storeId = ''
let plainOld: Buffer
let plainNew: Buffer

type LineOpts = { attrs?: string | null; customized?: boolean; exportedAt?: Date | null; link?: string | null; sku?: string }
type OrderOpts = LineOpts & { id: string; num: string; placedAt: string; task?: string | null; folder?: string | null; pipelineStatus?: string; financialStatus?: string }

async function makeOrder(o: OrderOpts) {
  await prisma.order.create({
    data: {
      id: o.id, projectId: PROJECT, storeId, shopifyOrderNumber: o.num, financialStatus: o.financialStatus ?? 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
      totalFees: 0, refundedAmount: 0, placedAt: new Date(o.placedAt), pipelineStatus: o.pipelineStatus ?? 'READY_TO_PRODUCTION',
      lines: { create: [{
        shopifyLineId: `${o.id}-l1`, sku: o.sku ?? SKU, productTitle: 'Hoodie', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP,
        customAttributesJson: o.attrs === undefined ? '[{"key":"_product_url","value":"https://x.test/p"}]' : o.attrs,
        customized: o.customized ?? false, exportedAt: o.exportedAt ?? null, designDriveLink: o.link ?? null,
      }] },
    },
  })
  if (o.task !== null) {
    await prisma.designTask.create({ data: {
      orderId: o.id, shopifyLineId: `${o.id}-l1`, taskKey: `${o.num.replace('#', '')}_1`, status: o.task ?? 'DONE', readiness: 'AUTO', kpi: 0, slaHours: 24,
      driveFolderUrl: o.folder ?? null,
    } })
  }
}

async function addMockup(orderId: string, bytes: Buffer, printArea = 'Preview no-name', fileName = 'Preview no-name.jpg') {
  const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId } })
  return saveArtwork({ lineId: line.id, printArea, fileName, mimeType: 'image/jpeg', bytes, uploadedById: null, source: 'MANUAL', kind: 'MOCKUP' })
}

async function setup(target: Partial<OrderOpts> = {}, sources: { old?: Partial<OrderOpts>; fresh?: Partial<OrderOpts> } = {}) {
  await prisma.order.deleteMany({ where: { id: { in: ORDERS } } })
  await makeOrder({ id: SRC_OLD, num: '#LBM1', placedAt: '2026-11-01', folder: 'https://drive.google.com/drive/folders/LIBFOLDER', ...sources.old })
  await makeOrder({ id: SRC_NEW, num: '#LBM2', placedAt: '2026-11-05', folder: 'https://drive.google.com/drive/folders/OTHERFOLDER', ...sources.fresh })
  await makeOrder({ id: TARGET, num: '#LBM3', placedAt: '2026-11-10', link: 'https://drive.google.com/drive/folders/LIBFOLDER', ...target })
  pushed.length = 0
}

const targetMockups = () => prisma.designArtwork.findMany({ where: { orderId: TARGET, kind: 'MOCKUP' } })
const fileBytes = (a: { storagePath: string | null }) => fs.readFileSync(localArtworkPath(a.storagePath)!)

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'LBM', startDate: new Date('2026-01-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  plainOld = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#112233' } }).jpeg().toBuffer()
  plainNew = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#445566' } }).jpeg().toBuffer()
})

beforeEach(async () => { await prisma.order.deleteMany({ where: { id: { in: ORDERS } } }) })

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: ORDERS } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('saveLibraryMockups', () => {
  it('gives a no-custom line the plain mockup of the line its library link points to, and logs where it came from', async () => {
    await setup()
    await addMockup(SRC_OLD, plainOld)
    await addMockup(SRC_NEW, plainNew)
    const r = await saveLibraryMockups(TARGET)
    expect(r).toEqual({ saved: 1, errors: [] })
    const [m] = await targetMockups()
    expect(m.printArea).toBe(LIBRARY_MOCKUP_PART)
    expect(m.source).toBe('AUTO')
    expect(fileBytes(m).equals(plainOld)).toBe(true)
    expect(pushed).toEqual([m.id])
    const ev = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { orderId: TARGET }, type: 'ARTWORK' } })
    expect(ev.message).toContain('LBM1_1')
    expect(ev.message).toContain(SKU)
  })

  it('takes the newest approved no-custom line when the library points nowhere it knows', async () => {
    await setup({ link: null })
    await addMockup(SRC_OLD, plainOld)
    await addMockup(SRC_NEW, plainNew)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(1)
    expect(fileBytes((await targetMockups())[0]).equals(plainNew)).toBe(true)
  })

  it('runs once: a line that has a mockup, even a removed one, is left alone', async () => {
    await setup()
    await addMockup(SRC_OLD, plainOld)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(1)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
    await prisma.designArtwork.updateMany({ where: { orderId: TARGET }, data: { removedAt: new Date() } })
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
  })

  it('skips a line the shopper personalised, one whose properties are not read yet, and one already sent', async () => {
    for (const target of [
      { attrs: '[{"key":"Custom Name","value":"Bob"}]' },
      { customized: true },
      { attrs: null },
      { exportedAt: new Date('2026-11-12') },
    ]) {
      await setup(target)
      await addMockup(SRC_OLD, plainOld)
      expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
    }
  })

  it('skips a closed order and a line without a task', async () => {
    await setup({ financialStatus: 'REFUNDED' })
    await addMockup(SRC_OLD, plainOld)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
    await setup({ task: null })
    await addMockup(SRC_OLD, plainOld)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
  })

  it('never copies from an unapproved line, a personalised line, another SKU, or a QA board', async () => {
    await setup({}, { old: { task: 'REVIEW' }, fresh: { attrs: '[{"key":"Name","value":"Amy"}]' } })
    await addMockup(SRC_OLD, plainOld)
    await addMockup(SRC_NEW, plainNew)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)

    await setup({}, { old: { sku: 'OTHER-SKU' }, fresh: { sku: 'OTHER-SKU' } })
    await addMockup(SRC_OLD, plainOld)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)

    await setup()
    await addMockup(SRC_OLD, plainOld, 'QA - reference and safezone', 'LIT1-reference-and-safezone-review.jpg')
    await addMockup(SRC_NEW, plainNew)
    expect((await saveLibraryMockups(TARGET)).saved).toBe(1)
    expect(fileBytes((await targetMockups())[0]).equals(plainNew)).toBe(true)
  })

  it('copies only a mockup named as plain: an automatic "Preview" may be the store photo with a sample name', async () => {
    await setup()
    await addMockup(SRC_OLD, plainOld, 'Preview', 'Preview.jpg')
    expect((await saveLibraryMockups(TARGET)).saved).toBe(0)
    await addMockup(SRC_NEW, plainNew, 'Product mockup', 'LIT2_MOCKUP_NO_NAME_BLACK_v1.jpg')
    expect((await saveLibraryMockups(TARGET)).saved).toBe(1)
    expect(fileBytes((await targetMockups())[0]).equals(plainNew)).toBe(true)
  })

  it('waits when the SKU has no plain mockup yet', async () => {
    await setup()
    expect(await saveLibraryMockups(TARGET)).toEqual({ saved: 0, errors: [] })
    expect(await targetMockups()).toHaveLength(0)
  })
})
