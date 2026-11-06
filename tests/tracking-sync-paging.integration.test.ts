import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { loadOrdersForShipmentSync, SHIPMENT_SYNC_PAGE_SIZE } from '@/lib/repos/shipments'

const SHOP = 'tsp-store.myshopify.com'
const OTHER_SHOP = 'tsp-other.myshopify.com'
const PROJECT = 'proj_tsp'
const OTHER_PROJECT = 'proj_tsp_other'
const SINCE = new Date('2026-10-01T00:00:00Z')
const IN_WINDOW = new Date('2026-10-15T12:00:00Z')
const BEFORE_WINDOW = new Date('2026-09-20T12:00:00Z')

// 1,700 is about the production window that failed (1,600 orders); the exact multiple pins the page boundary.
const BIG_WINDOWS = [1700, 2 * SHIPMENT_SYNC_PAGE_SIZE]
let storeId = ''
let otherStoreId = ''

const orderId = (tag: string, n: number) => `gid://shopify/Order/tsp-${tag}-${n}`

const orderRow = (tag: string, n: number, store: string, project: string, placedAt: Date) => ({
  id: orderId(tag, n),
  storeId: store,
  projectId: project,
  shopifyOrderNumber: `#TSP${n}`,
  financialStatus: 'PAID',
  fulfillmentStatus: 'UNFULFILLED',
  currency: 'USD',
  grossAmount: 10,
  expectedPayout: 9,
  placedAt,
})

async function seed(tag: string, count: number, store: string, project: string, placedAt: Date, linesPerOrder: number) {
  const CHUNK = 500
  for (let from = 0; from < count; from += CHUNK) {
    const ids = Array.from({ length: Math.min(CHUNK, count - from) }, (_, i) => from + i)
    await prisma.order.createMany({ data: ids.map(n => orderRow(tag, n, store, project, placedAt)) })
    await prisma.orderLine.createMany({
      data: ids.flatMap(n =>
        Array.from({ length: linesPerOrder }, (_, p) => ({
          orderId: orderId(tag, n),
          shopifyLineId: `gid://shopify/LineItem/tsp-${tag}-${n}-${p + 1}`,
          linePosition: p,
          sku: `SKU-${n}-${p + 1}`,
          productTitle: `Product ${n}-${p + 1}`,
          qty: 1,
          unitPrice: 5,
        })),
      ),
    })
  }
}

async function cleanup() {
  await prisma.order.deleteMany({ where: { storeId: { in: [storeId, otherStoreId].filter(Boolean) } } })
}

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.project.createMany({
    data: [
      { id: PROJECT, name: 'TSP', startDate: new Date('2026-05-01') },
      { id: OTHER_PROJECT, name: 'TSP other', startDate: new Date('2026-05-01') },
    ],
  })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'TSP' } })).id
  otherStoreId = (await prisma.shopifyStore.create({ data: { shop: OTHER_SHOP, orderPrefix: 'TSPO' } })).id
}, 60_000)

afterAll(async () => {
  await cleanup()
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER_PROJECT] } } })
}, 60_000)

describe('loadOrdersForShipmentSync', () => {
  describe.each(BIG_WINDOWS)('a window of %i orders, more than one query can bind', count => {
    beforeAll(async () => {
      await cleanup()
      await seed('big', count, storeId, PROJECT, IN_WINDOW, 2)
    }, 120_000)

    afterAll(cleanup, 60_000)

    it('returns every order of the window once, each with its lines in line order', async () => {
      const orders = await loadOrdersForShipmentSync(storeId, SINCE)

      expect(orders).toHaveLength(count)
      expect(new Set(orders.map(o => o.id)).size).toBe(count)
      expect(orders.every(o => o.lines.length === 2)).toBe(true)
      expect(orders.every(o => o.lines[0].linePosition === 0 && o.lines[1].linePosition === 1)).toBe(true)
    }, 60_000)

    it('returns the orders in a deterministic order, by id', async () => {
      const ids = (await loadOrdersForShipmentSync(storeId, SINCE)).map(o => o.id)

      expect(ids).toEqual([...ids].sort())
    }, 60_000)
  })

  describe('a small window', () => {
    beforeEach(cleanup, 60_000)

    it('returns exactly the selected fields of an order and its lines, lines in line order', async () => {
      await prisma.order.create({
        data: {
          ...orderRow('small', 1, storeId, PROJECT, IN_WINDOW),
          lines: {
            create: [
              { shopifyLineId: 'gid://shopify/LineItem/tsp-small-2', linePosition: 1, sku: null, productTitle: 'Second', shopifyProductType: 'Mug', resolvedSupplierId: null, qty: 1, unitPrice: 5 },
              { shopifyLineId: 'gid://shopify/LineItem/tsp-small-1', linePosition: 0, sku: 'TOTE-1', productTitle: 'First', shopifyProductType: 'Tote', resolvedSupplierId: null, qty: 2, unitPrice: 7 },
            ],
          },
        },
      })

      const orders = await loadOrdersForShipmentSync(storeId, SINCE)

      expect(orders).toEqual([
        {
          id: orderId('small', 1),
          projectId: PROJECT,
          shopifyOrderNumber: '#TSP1',
          fulfillmentStatus: 'UNFULFILLED',
          lines: [
            { shopifyLineId: 'gid://shopify/LineItem/tsp-small-1', sku: 'TOTE-1', productTitle: 'First', shopifyProductType: 'Tote', linePosition: 0, resolvedSupplierId: null },
            { shopifyLineId: 'gid://shopify/LineItem/tsp-small-2', sku: null, productTitle: 'Second', shopifyProductType: 'Mug', linePosition: 1, resolvedSupplierId: null },
          ],
        },
      ])
    })

    it('leaves out orders older than since and orders of another store', async () => {
      await seed('in', 1, storeId, PROJECT, IN_WINDOW, 1)
      await seed('old', 3, storeId, PROJECT, BEFORE_WINDOW, 1)
      await seed('other', 3, otherStoreId, OTHER_PROJECT, IN_WINDOW, 1)

      const orders = await loadOrdersForShipmentSync(storeId, SINCE)

      expect(orders.map(o => o.id)).toEqual([orderId('in', 0)])
    })

    it('includes an order placed exactly at since', async () => {
      await seed('edge', 1, storeId, PROJECT, SINCE, 1)

      const orders = await loadOrdersForShipmentSync(storeId, SINCE)

      expect(orders.map(o => o.id)).toEqual([orderId('edge', 0)])
    })
  })
})
