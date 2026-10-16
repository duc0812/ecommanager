import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { generateWorkerToken } from '@/lib/artwork-worker'
import { syncDesignTasks } from '@/lib/design-tasks'
import { POST as scheduledRoute } from '@/app/api/design-studio/worker/auto-render/route'

const SHOP = 'asch.myshopify.com'
const PROJECT = 'proj_asch'
const SUP = 'sup_asch'
const TPL = 'tpl_asch'
const P1 = 'gid://shopify/Product/9940001'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-print-body')])
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asch-storage-'))
const field = { field: 'Custom Name', layer: '@Custom Name', sample: 'Harry', font: 'HarryP', sizePx: 175, color: '#fbe8bf', align: 'left',
  box: { x: 100, y: 100, w: 1000, h: 300 }, anchor: 'center', fit: 'shrink' }

let storeId = ''
let token = ''
const keys: Record<string, string> = {}

function call(auth = true) {
  const headers = new Headers()
  if (auth) headers.set('Authorization', `Bearer ${token}`)
  return scheduledRoute(new NextRequest('http://localhost/api/design-studio/worker/auto-render', { method: 'POST', headers }))
}

async function makeOrder(name: string, attrs: { key: string; value: string }[]) {
  const id = `gid://test/Order/asch-${name}`
  await prisma.order.create({ data: {
    id, projectId: PROJECT, storeId, shopifyOrderNumber: `#ASCH${name}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-15'), pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [{ shopifyLineId: 'l1', sku: 'TUMB-20', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1, shopifyProductId: P1,
      resolvedSupplierId: SUP, resolvedSupplierSku: 'UT2-20OZ', customized: true, customAttributesJson: JSON.stringify(attrs) }] },
  } })
  await syncDesignTasks(id)
  keys[name] = (await prisma.designTask.findFirstOrThrow({ where: { orderId: id } })).taskKey
  return id
}

const jobsFor = (orderId: string) => prisma.artworkJob.findMany({ where: { kind: 'RENDER_LINE', orderId } })
const named = (name: string) => `gid://test/Order/asch-${name}`

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'ASCH', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.create({ data: { id: SUP, name: 'ASCH Sup', code: 'ASCH' } })
  await prisma.printTemplate.create({ data: {
    id: TPL, supplierId: SUP, name: 'Tumbler 20oz', widthPx: 3270, heightPx: 1860, dpi: 300, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 3270, h: 1860 }]),
  } })
  await prisma.productProfile.create({ data: { storeId, shopifyProductId: P1, title: 'Tumbler', printTemplateId: TPL } })
  const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'artwork.png', mimeType: 'image/png', size: PNG.length, sha256: 'asch-art', storagePath: 'library/asch/artwork.png' } })
  await prisma.artworkEntry.create({ data: {
    storeId, shopifyProductId: P1, printTemplateId: TPL, supplierId: SUP, title: 'Tumbler', status: 'READY', artworkFileId: art.id,
    fields: JSON.stringify([field]), parsedAt: new Date(),
  } })
  token = await generateWorkerToken()

  await makeOrder('ready', [{ key: 'Custom Name', value: 'Marie' }])
  await makeOrder('empty', [{ key: 'Custom Name: Yes Or No?', value: 'No' }])
  const withFile = await makeOrder('file', [{ key: 'Custom Name', value: 'Ana' }])
  const line = await prisma.orderLine.findFirstOrThrow({ where: { orderId: withFile } })
  await prisma.designArtwork.create({ data: {
    orderId: withFile, shopifyLineId: 'l1', printArea: 'Print', version: 1, fileName: 'p.png', size: 1, mimeType: 'image/png', storage: 'LOCAL', storagePath: `x/${line.id}.png`,
  } })
  await makeOrder('doing', [{ key: 'Custom Name', value: 'Leo' }])
  await prisma.designTask.update({ where: { taskKey: keys.doing }, data: { status: 'DOING' } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { storeId } })
  await prisma.artworkJob.deleteMany({ where: { orderId: { startsWith: 'gid://test/Order/asch-' } } })
  await prisma.artworkEntry.deleteMany({ where: { storeId } })
  await prisma.libraryFile.deleteMany({ where: { sha256: 'asch-art' } })
  await prisma.productProfile.deleteMany({ where: { storeId } })
  await prisma.printTemplate.deleteMany({ where: { id: TPL } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.shopifyStore.deleteMany({ where: { id: storeId } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('daily auto-render', () => {
  it('needs the worker token', async () => {
    expect((await call(false)).status).toBe(401)
  })

  it('queues a render for an untouched task whose customer filled every field, and leaves the others to the designer', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const summary = await res.json()
    const ours = summary.queued.filter((q: { taskKey: string }) => Object.values(keys).includes(q.taskKey))
    expect(ours.map((q: { taskKey: string }) => q.taskKey)).toEqual([keys.ready])
    expect(summary.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'Khách chưa điền đủ' }), expect.objectContaining({ reason: 'Đã có file in' }),
    ]))

    expect(await jobsFor(named('ready'))).toEqual([expect.objectContaining({ status: 'QUEUED', printArea: 'Print', shopifyLineId: 'l1' })])
    for (const name of ['empty', 'file', 'doing']) expect(await jobsFor(named(name))).toEqual([])
    const events = await prisma.designTaskEvent.findMany({ where: { task: { taskKey: keys.ready } } })
    expect(events.map(e => e.message)).toContain('Lịch hằng ngày: xếp hàng tạo file in tự động (Print) từ artwork gốc')
  })

  it('tries a line once: a later run neither doubles the job nor redoes a failed one', async () => {
    await call()
    expect(await jobsFor(named('ready'))).toHaveLength(1)
    await prisma.artworkJob.updateMany({ where: { orderId: named('ready') }, data: { status: 'FAILED', error: 'font' } })
    const summary = await (await call()).json()
    expect(summary.queued.map((q: { taskKey: string }) => q.taskKey)).not.toContain(keys.ready)
    expect(summary.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'Đã từng dựng tự động' })]))
    expect(await jobsFor(named('ready'))).toHaveLength(1)
  })
})
