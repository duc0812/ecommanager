import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { listOrdersWithLines, type OrderFilter } from '@/lib/repos/orders'

const SHOP = 'olp-store.myshopify.com'
const OTHER_SHOP = 'olp-other.myshopify.com'
const PROJECT = 'proj_olp'
const OTHER_PROJECT = 'proj_olp_other'
const SUPPLIER = 'sup_olp'
const BASE = Date.parse('2026-10-01T00:00:00Z')
// About the first store's October (the P&L month that answered 500) and more than one query can bind (997 parents).
const BIG = 1200
const EMPTY = [7, 499, 500, 1001]

let storeId = ''
let otherStoreId = ''

const orderId = (tag: string, n: number) => `gid://shopify/Order/olp-${tag}-${n}`
const placedAt = (n: number) => new Date(BASE + n * 60_000)

const orderRow = (tag: string, n: number, store: string, project: string, at: Date) => ({
  id: orderId(tag, n),
  storeId: store,
  projectId: project,
  shopifyOrderNumber: `#OLP${n}`,
  financialStatus: 'PAID',
  fulfillmentStatus: null,
  pipelineStatus: 'READY_TO_PRODUCTION',
  currency: 'USD',
  grossAmount: 10,
  expectedPayout: 9,
  placedAt: at,
})

async function seedBig() {
  const CHUNK = 500
  for (let from = 0; from < BIG; from += CHUNK) {
    const ns = Array.from({ length: Math.min(CHUNK, BIG - from) }, (_, i) => from + i)
    await prisma.order.createMany({ data: ns.map(n => orderRow('big', n, storeId, PROJECT, placedAt(n))) })
    await prisma.orderLine.createMany({
      data: ns.filter(n => !EMPTY.includes(n)).map(n => ({
        orderId: orderId('big', n),
        shopifyLineId: `gid://shopify/LineItem/olp-big-${n}`,
        linePosition: 0,
        sku: `SKU-${n}`,
        productTitle: `Product ${n}`,
        qty: 1,
        unitPrice: 5,
      })),
    })
  }
}

async function cleanup() {
  await prisma.order.deleteMany({ where: { storeId: { in: [storeId, otherStoreId].filter(Boolean) } } })
}

// The query listOrdersWithLines ran before it paged: one findMany, the lines as an ordered nested relation.
function singleQuery(where: any, take: number, skip: number) {
  return prisma.order.findMany({
    where,
    orderBy: { placedAt: 'desc' },
    take,
    skip,
    include: {
      lines: { orderBy: { linePosition: 'asc' } },
      store: { select: { id: true, shop: true, orderPrefix: true, ianaTimezone: true, project: { select: { name: true } } } },
      defaultSupplier: { select: { id: true, name: true, code: true, firstItemShipFee: true, additionalItemShipFee: true } },
    },
  })
}

beforeAll(async () => {
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.supplier.deleteMany({ where: { id: SUPPLIER } })
  await prisma.project.createMany({
    data: [
      { id: PROJECT, name: 'OLP', startDate: new Date('2026-05-01') },
      { id: OTHER_PROJECT, name: 'OLP other', startDate: new Date('2026-05-01') },
    ],
  })
  await prisma.supplier.create({ data: { id: SUPPLIER, name: 'OLP Supplier', code: 'OLP', firstItemShipFee: 4, additionalItemShipFee: 2 } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: SHOP, orderPrefix: 'OLP', projectId: PROJECT, ianaTimezone: 'America/New_York' } })).id
  otherStoreId = (await prisma.shopifyStore.create({ data: { shop: OTHER_SHOP, orderPrefix: 'OLPO', projectId: OTHER_PROJECT } })).id
}, 60_000)

afterAll(async () => {
  await cleanup()
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } })
  await prisma.project.deleteMany({ where: { id: { in: [PROJECT, OTHER_PROJECT] } } })
  await prisma.supplier.deleteMany({ where: { id: SUPPLIER } })
}, 60_000)

describe('listOrdersWithLines over more orders than one query can bind', () => {
  beforeAll(async () => {
    await cleanup()
    await seedBig()
    await prisma.order.createMany({ data: [1, 2, 3].map(n => orderRow('other', n, otherStoreId, OTHER_PROJECT, placedAt(n))) })
  }, 120_000)

  afterAll(cleanup, 60_000)

  const byPlacedDesc = () => Array.from({ length: BIG }, (_, i) => orderId('big', BIG - 1 - i))

  it('returns every matching order, each with its lines', async () => {
    const orders = await listOrdersWithLines({ storeIds: [storeId], limit: 5000 })

    expect(orders).toHaveLength(BIG)
    expect(new Set(orders.map(o => o.id)).size).toBe(BIG)
    expect(orders.filter(o => o.lines.length === 1).every(o => o.lines[0].orderId === o.id && o.lines[0].sku === `SKU-${o.id.split('-').pop()}`)).toBe(true)
  }, 60_000)

  it('keeps the requested order across chunk boundaries (placedAt desc)', async () => {
    const orders = await listOrdersWithLines({ storeIds: [storeId], limit: 5000 })

    expect(orders.map(o => o.id)).toEqual(byPlacedDesc())
  }, 60_000)

  it('cuts exactly at limit, and at page/pageSize', async () => {
    const limited = await listOrdersWithLines({ storeIds: [storeId], limit: 1100 })
    const page2 = await listOrdersWithLines({ storeIds: [storeId], pageSize: 600, page: 2 })
    const page3 = await listOrdersWithLines({ storeIds: [storeId], pageSize: 600, page: 3 })

    expect(limited.map(o => o.id)).toEqual(byPlacedDesc().slice(0, 1100))
    expect(page2.map(o => o.id)).toEqual(byPlacedDesc().slice(600, 1200))
    expect(page3).toEqual([])
  }, 60_000)

  it('still returns an order with zero lines, with an empty line list', async () => {
    const orders = await listOrdersWithLines({ storeIds: [storeId], limit: 5000 })
    const empty = orders.filter(o => o.lines.length === 0).map(o => o.id).sort()

    expect(empty).toEqual(EMPTY.map(n => orderId('big', n)).sort())
  }, 60_000)

  it('keeps the default limit of 500 when no limit is given', async () => {
    const orders = await listOrdersWithLines({ storeIds: [storeId] })

    expect(orders.map(o => o.id)).toEqual(byPlacedDesc().slice(0, 500))
  }, 60_000)
})

describe('listOrdersWithLines returns what the single query returned', () => {
  beforeAll(async () => {
    await cleanup()
    const tie = placedAt(5)
    await prisma.order.create({ data: { ...orderRow('same', 1, storeId, PROJECT, tie), defaultSupplierId: SUPPLIER, lines: { create: [
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-1-c', linePosition: 2, sku: 'C', productTitle: 'Third', qty: 1, unitPrice: 3, resolvedSupplierId: SUPPLIER },
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-1-a', linePosition: 0, sku: 'A', productTitle: 'First', qty: 2, unitPrice: 1, shopifyProductType: 'Tote' },
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-1-b', linePosition: 1, sku: null, productTitle: 'Custom Text', qty: 1, unitPrice: 0, shopifyProductType: 'Custom Text' },
    ] } } })
    // Old orders keep linePosition 0 on every line: ties inside an order.
    await prisma.order.create({ data: { ...orderRow('same', 2, storeId, PROJECT, tie), lines: { create: [
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-2-z', linePosition: 0, sku: 'Z', productTitle: 'Zed', qty: 1, unitPrice: 1 },
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-2-y', linePosition: 0, sku: 'Y', productTitle: 'Why', qty: 1, unitPrice: 1 },
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-2-x', linePosition: 0, sku: 'X', productTitle: 'Ex', qty: 1, unitPrice: 1 },
    ] } } })
    await prisma.order.create({ data: { ...orderRow('same', 3, storeId, PROJECT, tie) } })
    await prisma.order.create({ data: { ...orderRow('same', 4, storeId, PROJECT, placedAt(9)), pipelineStatus: 'PENDING_DESIGN', lines: { create: [
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-4-a', linePosition: 0, sku: 'M', productTitle: 'Mug', qty: 1, unitPrice: 8, resolvedSupplierId: SUPPLIER },
    ] } } })
    await prisma.order.create({ data: { ...orderRow('same', 5, otherStoreId, OTHER_PROJECT, placedAt(1)), lines: { create: [
      { shopifyLineId: 'gid://shopify/LineItem/olp-same-5-a', linePosition: 0, sku: 'O', productTitle: 'Other', qty: 1, unitPrice: 8 },
    ] } } })
  }, 60_000)

  afterAll(cleanup, 60_000)

  // Each case: the filter, the where buildWhere makes of it (both stores are this file's own), take, skip.
  const unfulfilled = { OR: [{ fulfillmentStatus: null }, { fulfillmentStatus: { notIn: ['fulfilled', 'FULFILLED'] } }] }
  it.each<[string, (stores: string[]) => [OrderFilter, any], number, number]>([
    ['one store, default limit', s => [{ storeIds: s.slice(0, 1) }, { storeId: { in: s.slice(0, 1) } }], 500, 0],
    ['two stores, limit 3', s => [{ storeIds: s, limit: 3 }, { storeId: { in: s } }], 3, 0],
    ['two stores, page 2 of 2', s => [{ storeIds: s, pageSize: 2, page: 2 }, { storeId: { in: s } }], 2, 2],
    ['by pipeline status', s => [{ storeIds: s, pipelineStatus: 'PENDING_DESIGN' }, { storeId: { in: s }, pipelineStatus: 'PENDING_DESIGN', AND: [unfulfilled] }], 500, 0],
  ])('%s: every field, the order of the orders and of each order\'s lines', async (_name, make, take, skip) => {
    const [f, where] = make([storeId, otherStoreId])
    const before = await singleQuery(where, take, skip)
    const after = await listOrdersWithLines(f)

    expect(before.length).toBeGreaterThan(0)
    expect(after).toEqual(before)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(after.map(o => [o.id, o.lines.map(l => l.shopifyLineId)])).toEqual(before.map(o => [o.id, o.lines.map(l => l.shopifyLineId)]))
  })
})
