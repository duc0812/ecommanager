import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { loadOrdersForDesignEntry, reevaluateOrdersForDesignEntry } from '@/lib/repos/design-reeval'

const SHOP = 'drp-store.myshopify.com'
const PROJECT = 'proj_drp'
const SUP = 'sup_drp'
const OTHER_SUP = 'sup_drp_other'
const LINK = 'https://drive.example/drp-design'
const OWN_LINK = 'https://drive.example/drp-own'
const PARENT = { sku: 'DRP-', supplierId: SUP, matchMode: 'PARENT' }

// 1,897 is the largest supplier's open orders on the 2026-11-05 copy; 1,000 is an exact multiple of the 500-order chunk.
const BIG = [1000, 1897]
let storeId = ''

const orderId = (tag: string, n: number) => `gid://shopify/Order/drp-${tag}-${n}`
const orderRow = (tag: string, n: number, pipelineStatus = 'PENDING_DESIGN') => ({
  id: orderId(tag, n), storeId, projectId: PROJECT, shopifyOrderNumber: `#DRP${n}`, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
  pipelineStatus, currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: new Date('2026-10-15T00:00:00Z'),
})
const line = (oid: string, n: string, linePosition: number, more: Record<string, unknown> = {}) => ({
  orderId: oid, shopifyLineId: `gid://shopify/LineItem/drp-${n}`, linePosition, sku: `DRP-${n}`, productTitle: `Product ${n}`,
  qty: 1, unitPrice: 5, resolvedSupplierId: SUP, ...more,
})

// Every order: its matching line at position 0 inserted after a line of its own design at position 1.
async function seed(tag: string, count: number) {
  const CHUNK = 500
  for (let from = 0; from < count; from += CHUNK) {
    const ids = Array.from({ length: Math.min(CHUNK, count - from) }, (_, i) => from + i)
    await prisma.order.createMany({ data: ids.map(n => orderRow(tag, n)) })
    await prisma.orderLine.createMany({ data: ids.flatMap(n => [
      line(orderId(tag, n), `${tag}-${n}-own`, 1, { sku: `OWN-${n}`, designDriveLink: OWN_LINK }),
      line(orderId(tag, n), `${tag}-${n}-1`, 0),
    ]) })
  }
}

// The query the function ran before it was paged.
const oldQuery = (entry: { sku: string; supplierId: string; matchMode: string }) => {
  const isParent = (entry.matchMode ?? 'VARIANT').toUpperCase() === 'PARENT'
  const lineWhere: any = isParent
    ? { resolvedSupplierId: entry.supplierId, sku: { startsWith: entry.sku } }
    : { resolvedSupplierId: entry.supplierId, sku: entry.sku }
  return prisma.order.findMany({
    where: { pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] }, lines: { some: lineWhere } },
    select: {
      id: true, financialStatus: true, fulfillmentStatus: true, pipelineStatus: true,
      lines: {
        orderBy: { linePosition: 'asc' },
        select: {
          id: true, sku: true, resolvedSupplierId: true, resolvedSupplierSku: true, productTitle: true,
          shopifyProductType: true, previewCdnUrl: true, designDriveLink: true, customized: true,
        },
      },
    },
  })
}

async function cleanup() {
  if (storeId) await prisma.order.deleteMany({ where: { storeId } })
}

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, OTHER_SUP] } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
  await prisma.project.create({ data: { id: PROJECT, name: 'DRP', startDate: new Date('2026-05-01') } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'DRP' } })).id
  await prisma.supplier.createMany({ data: [{ id: SUP, name: 'DRP supplier', code: 'DRPSUP' }, { id: OTHER_SUP, name: 'DRP other', code: 'DRPOTH' }] })
  await prisma.skuSupplierDesign.create({ data: { sku: PARENT.sku, supplierId: SUP, matchMode: 'PARENT', designLink: LINK, ready: true } })
}, 60_000)

afterAll(async () => {
  await cleanup()
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.supplier.deleteMany({ where: { id: { in: [SUP, OTHER_SUP] } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}, 60_000)

describe('design re-evaluation over more open orders than one query can bind', () => {
  describe.each(BIG)('%i matching orders', count => {
    beforeAll(async () => {
      await cleanup()
      await seed('big', count)
    }, 120_000)

    afterAll(cleanup, 60_000)

    it('loads every matching order once, with all its lines in line order, in the order of the order query', async () => {
      const orders = await loadOrdersForDesignEntry(PARENT)

      expect(orders).toHaveLength(count)
      expect(new Set(orders.map(o => o.id)).size).toBe(count)
      expect(orders.every(o => o.lines.length === 2 && o.lines[0].sku?.startsWith('DRP-') && o.lines[1].sku?.startsWith('OWN-'))).toBe(true)
      const parentOrder = await prisma.order.findMany({
        where: { pipelineStatus: { notIn: ['CANCELLED', 'REFUNDED'] }, lines: { some: { resolvedSupplierId: SUP, sku: { startsWith: PARENT.sku } } } },
        select: { id: true },
      })
      expect(orders.map(o => o.id)).toEqual(parentOrder.map(o => o.id))
    }, 60_000)

    it('re-evaluates every one of them: the design link lands on the matching line, the order is design-ready', async () => {
      const updated = await reevaluateOrdersForDesignEntry(PARENT)

      expect(updated).toBe(count)
      expect(await prisma.orderLine.count({ where: { order: { storeId }, sku: { startsWith: 'DRP-' }, designDriveLink: LINK } })).toBe(count)
      expect(await prisma.orderLine.count({ where: { order: { storeId }, sku: { startsWith: 'OWN-' }, designDriveLink: OWN_LINK } })).toBe(count)
      expect(await prisma.order.count({ where: { storeId, designReady: true, designDriveLink: LINK } })).toBe(count)
    }, 120_000)
  })
})

describe('a small set loads exactly what the single query loaded', () => {
  beforeEach(async () => {
    await cleanup()
    const o = (tag: string, status?: string) => prisma.order.create({ data: orderRow(tag, 0, status) })
    await o('a')
    await prisma.orderLine.create({ data: line(orderId('a', 0), 'a-2', 1) })
    await prisma.orderLine.create({ data: line(orderId('a', 0), 'a-other', 0, { sku: 'ZZZ-1', resolvedSupplierId: OTHER_SUP }) })
    await o('ties', 'READY_TO_PRODUCTION')
    for (const x of ['z', 'y', 'x']) await prisma.orderLine.create({ data: line(orderId('ties', 0), `ties-${x}`, 0) })
    await o('addon', 'EXPORTED')
    await prisma.orderLine.create({ data: line(orderId('addon', 0), 'addon-1', 0, { designDriveLink: OWN_LINK }) })
    await prisma.orderLine.create({ data: line(orderId('addon', 0), 'addon-fee', 1, { sku: null, productTitle: 'Shipping Protection', resolvedSupplierId: null, shopifyProductType: 'Add-on' }) })
    await o('cancelled', 'CANCELLED')
    await prisma.orderLine.create({ data: line(orderId('cancelled', 0), 'cancelled-1', 0) })
    await o('refunded', 'REFUNDED')
    await prisma.orderLine.create({ data: line(orderId('refunded', 0), 'refunded-1', 0) })
    await o('foreign')
    await prisma.orderLine.create({ data: line(orderId('foreign', 0), 'foreign-1', 0, { resolvedSupplierId: OTHER_SUP }) })
    await o('nomatch', 'PENDING_MAPPING')
    await prisma.orderLine.create({ data: line(orderId('nomatch', 0), 'nomatch-1', 0, { sku: 'XYZ-1' }) })
  })

  it.each([
    ['a PARENT entry', PARENT],
    ['a VARIANT entry', { sku: 'DRP-a-2', supplierId: SUP, matchMode: 'VARIANT' }],
  ])('%s', async (_name, entry) => {
    const before = await oldQuery(entry)
    const after = await loadOrdersForDesignEntry(entry)

    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(after.map(o => [o.id, o.lines.map(l => l.id)])).toEqual(before.map(o => [o.id, o.lines.map(l => l.id)]))
    expect(after.length).toBe(entry.matchMode === 'PARENT' ? 3 : 1)
  })
})
