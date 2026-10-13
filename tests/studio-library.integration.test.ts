import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { transitionTask } from '@/lib/design-tasks'
import { loadReadyDesignEntries } from '@/lib/repos/design-library'
import { resolveOrderDesignByParent } from '@/lib/design-library'
import { findPublicArtwork } from '@/lib/public-artwork'
import { isReusableDesignLine } from '@/lib/studio-library'

const SHOP = 'studio-lib.myshopify.com'
const PROJECT = 'proj_studio_lib'
const SUP = 'sup_studio_lib'
const BASE = 'https://app.shop-tool.com'
const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL
const leader = { id: 'studio-lib-leader', name: 'Lead', role: 'ADMIN' }
let storeId = ''
let seq = 0

type Art = { area: string; drive?: string }

async function reviewTask(opts: { sku: string; customized?: boolean; attrs?: unknown[]; arts?: Art[]; printAreas?: string[]; supplierSku?: string }) {
  seq += 1
  const id = `gid://test/Order/studio-lib-${seq}`
  const attrs = [...(opts.attrs ?? [])] as { key: string; value: string }[]
  if (opts.printAreas) attrs.push({ key: '_print_files', value: JSON.stringify(opts.printAreas.map(a => ({ print_area: a, url: 'https://cdn.example/s.png' }))) })
  await prisma.order.create({ data: {
    id, projectId: PROJECT, storeId, shopifyOrderNumber: `#SLB${seq}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-10'), pipelineStatus: 'PENDING_DESIGN',
    lines: { create: [{ shopifyLineId: 'l1', sku: opts.sku, productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP,
      resolvedSupplierSku: opts.supplierSku ?? null, customized: opts.customized ?? false, customAttributesJson: JSON.stringify(attrs) }] },
  } })
  const ids: string[] = []
  for (const a of opts.arts ?? [{ area: 'Artwork' }]) {
    ids.push((await prisma.designArtwork.create({ data: {
      orderId: id, shopifyLineId: 'l1', printArea: a.area, version: 1, fileName: `${a.area.toLowerCase()}.png`, size: 1, mimeType: 'image/png',
      storagePath: a.drive ? null : `x/${seq}-${a.area}.png`, storage: a.drive ? 'DRIVE' : 'LOCAL', driveFileId: a.drive ? `f${seq}` : null, driveWebViewLink: a.drive ?? null,
    } })).id)
  }
  const key = `SLB${seq}_1`
  await prisma.designTask.create({ data: { orderId: id, shopifyLineId: 'l1', taskKey: key, status: 'REVIEW' } })
  return { id, key, artworkIds: ids }
}

const entry = (sku: string) => prisma.skuSupplierDesign.findUnique({ where: { sku_supplierId: { sku, supplierId: SUP } } })
const systemEvents = async (key: string) => (await prisma.designTaskEvent.findMany({ where: { task: { taskKey: key }, type: 'SYSTEM' } })).map(e => e.message)

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'Studio lib', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'STUDIOLIB' }, create: { id: SUP, name: 'Studio Lib Supplier', code: 'STUDIOLIB' }, update: {} })
  await prisma.printTemplate.create({ data: {
    supplierId: SUP, supplierSku: 'SLB-JERSEY', name: 'Jersey', widthPx: 100, heightPx: 100,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 50, h: 100 }, { name: 'Back', x: 50, y: 0, w: 50, h: 100 }]),
  } })
})
beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = BASE })
afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.skuSupplierDesign.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
})

describe('approving a non-customized line writes the design library', () => {
  it('LOCAL artwork: the entry is ready, source STUDIO, and holds the public URL — the line keeps the app path', async () => {
    const t = await reviewTask({ sku: 'SLB-MUG-11' })
    const r = await transitionTask(t.key, leader, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    const e = await entry('SLB-MUG-11')
    expect(e).toMatchObject({ ready: true, source: 'STUDIO', matchMode: 'VARIANT', designType: 'NON_CUSTOM' })
    expect(e!.designLink).toMatch(new RegExp(`^${BASE}/api/public/artwork/[0-9a-f]{64}/artwork\\.png$`))
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: t.id } })).designDriveLink).toBe(`/api/design-studio/file/${t.artworkIds[0]}`)
    const [, , , , token, fileName] = new URL(e!.designLink!).pathname.split('/')
    expect((await findPublicArtwork(token, fileName))?.id).toBe(t.artworkIds[0])
    expect((await systemEvents(t.key)).some(m => m.includes('Design Library'))).toBe(true)
  })

  it('the next order of that SKU resolves its design from the library, so it needs no task', async () => {
    const entries = await loadReadyDesignEntries()
    const res = resolveOrderDesignByParent(
      [{ index: 0, sku: 'SLB-MUG-11', isNonProduct: false, requiresDesign: true, resolvedSupplierId: SUP, existingDesignLink: null, customized: false }],
      entries,
    )
    expect(res.orderDesignReady).toBe(true)
    expect(res.lineLinks[0].designLink).toBe((await entry('SLB-MUG-11'))!.designLink)
  })

  it('Drive artwork: the entry holds the Drive link; several print areas are joined', async () => {
    const drive = 'https://drive.google.com/file/d/slb-drive/view'
    const one = await reviewTask({ sku: 'SLB-DRIVE', arts: [{ area: 'Artwork', drive }] })
    await transitionTask(one.key, leader, { to: 'DONE' })
    expect((await entry('SLB-DRIVE'))?.designLink).toBe(drive)

    const two = await reviewTask({ sku: 'SLB-TWO', supplierSku: 'SLB-JERSEY', arts: [{ area: 'Front', drive }, { area: 'Back' }] })
    await transitionTask(two.key, leader, { to: 'DONE' })
    const [front, back] = (await entry('SLB-TWO'))!.designLink!.split(' | ')
    expect(front).toBe(drive)
    expect(back).toMatch(new RegExp(`^${BASE}/api/public/artwork/[0-9a-f]{64}/back\\.png$`))
  })

  it('a customized line never feeds the library — by the stored flag or by its customer input', async () => {
    const flagged = await reviewTask({ sku: 'SLB-CUSTOM-1', customized: true })
    await transitionTask(flagged.key, leader, { to: 'DONE' })
    expect(await entry('SLB-CUSTOM-1')).toBeNull()
    const typed = await reviewTask({ sku: 'SLB-CUSTOM-2', customized: false, attrs: [{ key: 'Your Name', value: 'Janice' }] })
    await transitionTask(typed.key, leader, { to: 'DONE' })
    expect(await entry('SLB-CUSTOM-2')).toBeNull()
    expect((await systemEvents(typed.key)).some(m => m.includes('Design Library'))).toBe(false)
    const app = await reviewTask({ sku: 'SLB-CUSTOM-3', customized: false, printAreas: ['Artwork'] })
    expect(isReusableDesignLine(await prisma.orderLine.findFirstOrThrow({ where: { orderId: app.id } }))).toBe(false)
    await transitionTask(app.key, leader, { to: 'DONE' })
    expect(await entry('SLB-CUSTOM-3')).toBeNull()
  })

  it('fills the row the order sync opened for the missing design, and a PARENT entry that covers the SKU', async () => {
    const opened = await prisma.skuSupplierDesign.create({ data: { sku: 'SLB-OPEN', supplierId: SUP, ready: false, source: 'TRELLO', trelloCardId: 'card-x' } })
    const a = await reviewTask({ sku: 'SLB-OPEN' })
    await transitionTask(a.key, leader, { to: 'DONE' })
    const filled = await entry('SLB-OPEN')
    expect(filled).toMatchObject({ id: opened.id, ready: true, source: 'STUDIO', trelloCardId: 'card-x' })

    const parent = await prisma.skuSupplierDesign.create({ data: { sku: 'SLBP', supplierId: SUP, ready: false, matchMode: 'PARENT', designType: 'DUAL' } })
    const b = await reviewTask({ sku: 'SLBP-XL-BLACK' })
    await transitionTask(b.key, leader, { to: 'DONE' })
    expect(await entry('SLBP-XL-BLACK')).toBeNull()
    expect(await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ ready: true, source: 'STUDIO', matchMode: 'PARENT', designType: 'DUAL' })
  })

  it('an unusable public base URL does not block the approval: nothing is stored and the task says why', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3002'
    const t = await reviewTask({ sku: 'SLB-LOCALHOST' })
    const r = await transitionTask(t.key, leader, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    expect(r.order?.pipelineStatus).toBe('READY_TO_PRODUCTION')
    expect(await entry('SLB-LOCALHOST')).toBeNull()
    expect((await systemEvents(t.key)).some(m => m.startsWith('Chưa lưu vào Design Library'))).toBe(true)
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: t.artworkIds[0] } })).publicToken).toBeNull()
  })
})
