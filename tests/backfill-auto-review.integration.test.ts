import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import path from 'path'
import { prisma } from '@/lib/db'
import { AUTO_REVIEW_MESSAGE, syncDesignTasks } from '@/lib/design-tasks'

const SHOP = 'bfar.myshopify.com'
const SUP = 'sup_bfar'
const ORDER_ID = 'gid://test/Order/bfar-1'
const SCRIPT = path.resolve(__dirname, '../scripts/backfill-auto-review.mjs')
const files = (...areas: string[]) => JSON.stringify([{ key: '_print_files', value: JSON.stringify(areas.map(a => ({ print_area: a, url: `https://cdn.example/${a}.png` }))) }])
let version = 0

function run(...args: string[]): string {
  if (!/test\.db/.test(process.env.DATABASE_URL ?? '')) throw new Error('refusing to run the backfill outside test.db')
  return execFileSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }, encoding: 'utf8' })
}

async function art(shopifyLineId: string, printArea: string, source = 'AUTO') {
  await prisma.designArtwork.create({ data: {
    orderId: ORDER_ID, shopifyLineId, printArea, version: ++version, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png', source,
  } })
}

const status = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).status

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: 'proj_bfar' }, create: { id: 'proj_bfar', name: 'BFAR', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_bfar' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'BFAR' }, create: { id: SUP, name: 'BFAR Supplier', code: 'BFAR' }, update: {} })
  await prisma.printTemplate.create({ data: {
    supplierId: SUP, supplierSku: 'HOOD', name: 'Hoodie', widthPx: 10, heightPx: 10,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 10, h: 10 }, { name: 'Back', x: 0, y: 0, w: 10, h: 10 }]),
  } })
  const base = { qty: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true, productTitle: 'P' }
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: 'proj_bfar', storeId, shopifyOrderNumber: '#BFAR1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
    pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [
      { ...base, shopifyLineId: 'b1', linePosition: 1, sku: 'X1', customAttributesJson: files('PRINT') },
      { ...base, shopifyLineId: 'b2', linePosition: 2, sku: 'X2', customAttributesJson: files('FRONT', 'BACK') },
      { ...base, shopifyLineId: 'b3', linePosition: 3, sku: 'X3', customAttributesJson: files('PRINT') },
      { ...base, shopifyLineId: 'b4', linePosition: 4, sku: 'X4', customAttributesJson: files('PRINT') },
      { ...base, shopifyLineId: 'b5', linePosition: 5, sku: 'X5', resolvedSupplierSku: 'HOOD-L', customAttributesJson: null },
    ] },
  } })
  await syncDesignTasks(ORDER_ID)
  await art('b1', 'PRINT')
  await art('b2', 'FRONT')
  await art('b3', 'PRINT', 'MANUAL')
  await art('b4', 'PRINT')
  await prisma.designTask.update({ where: { taskKey: 'BFAR1_4' }, data: { status: 'DONE' } })
  await art('b5', 'Front')
  await art('b5', 'Back')
  await prisma.designTask.update({ where: { taskKey: 'BFAR1_5' }, data: { status: 'REJECTED' } })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('scripts/backfill-auto-review.mjs', () => {
  it('dry run reports and writes nothing', async () => {
    const out = run()
    expect(out).toMatch(/REVIEW {2}BFAR1_1 /)
    expect(out).toMatch(/REVIEW {2}BFAR1_5 /)
    expect(out).toMatch(/skip BFAR1_2 .*BACK/)
    expect(out).not.toMatch(/BFAR1_3|BFAR1_4/)
    expect(out).toMatch(/DRY-RUN/)
    expect(await status('BFAR1_1')).toBe('NEW')
  })

  it('--apply moves fully auto-covered open tasks to REVIEW once', async () => {
    expect(run('--apply')).toMatch(/APPLIED/)
    expect(await status('BFAR1_1')).toBe('REVIEW')
    expect(await status('BFAR1_5')).toBe('REVIEW')
    expect(await status('BFAR1_2')).toBe('NEW')
    expect(await status('BFAR1_3')).toBe('NEW')
    expect(await status('BFAR1_4')).toBe('DONE')
    const t = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'BFAR1_1' }, include: { events: true } })
    expect(t.readiness).toBe('AUTO')
    expect(t.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    const ev = t.events.filter(e => e.message === AUTO_REVIEW_MESSAGE)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: 'SYSTEM', actorId: null })
    expect(ev[0].createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000)

    run('--apply')
    const again = await prisma.designTaskEvent.count({ where: { task: { orderId: ORDER_ID }, message: AUTO_REVIEW_MESSAGE } })
    expect(again).toBe(2)
  })
})
