import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchSheetCsv: vi.fn(),
  fetchFulfillmentOrders: vi.fn(),
  createFulfillment: vi.fn(),
}))

vi.mock('@/lib/fulfillment/parse-sheet', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/fulfillment/parse-sheet')>()),
  fetchSheetCsv: mocks.fetchSheetCsv,
}))
vi.mock('@/lib/shopify-orders', () => ({
  fetchOrderFulfillmentOrdersByNames: mocks.fetchFulfillmentOrders,
  createFulfillment: mocks.createFulfillment,
}))

import { prisma } from '@/lib/db'
import { saveStoreCredential } from '@/lib/store-connections'
import { runAutoFulfillForStores } from '@/lib/fulfillment/auto-fulfill-stores'
import { orderNameHasPrefix } from '@/lib/fulfillment/auto-fulfill'

const SHOP_A = 'aff-a.myshopify.com'
const SHOP_B = 'aff-b.myshopify.com'
const SHOP_C = 'aff-c.myshopify.com'
const PROJECT = 'proj_aff'
const MINE = [SHOP_A, SHOP_B, SHOP_C]
let storeA = ''
let storeB = ''
let storeC = ''

const sheet = (id: string, name: string) => ({ id, name, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, enabled: true, storeBase: 'https://litzzy.com' })
const SHEETS = [sheet('aff1', 'Mangoshao'), sheet('aff2', 'Jomall')]

async function cleanup() {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: { in: MINE } }, select: { id: true } })
  await prisma.order.deleteMany({ where: { storeId: { in: stores.map(s => s.id) } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: { in: MINE } } })
  await prisma.project.deleteMany({ where: { id: PROJECT } })
}

const dbOrder = (id: string, storeId: string, name: string) => prisma.order.create({ data: {
  id, projectId: PROJECT, storeId, shopifyOrderNumber: `#${name}`, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
  totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'), fulfillmentStatus: 'UNFULFILLED',
} })

beforeAll(async () => {
  await cleanup()
  await prisma.project.create({ data: { id: PROJECT, name: 'AFF', startDate: new Date('2026-05-01') } })
  storeA = (await prisma.shopifyStore.create({ data: { shop: SHOP_A, orderPrefix: 'LIT', connectedAt: new Date('2026-09-01') } })).id
  storeB = (await prisma.shopifyStore.create({ data: { shop: SHOP_B, orderPrefix: 'REMI', connectedAt: new Date('2026-09-02') } })).id
  for (const [id, token] of [[storeA, 'token-aff-a'], [storeB, 'token-aff-b']]) await saveStoreCredential(id, { authMode: 'TOKEN', accessToken: token })
  await dbOrder('gid://test/Order/aff-lit1', storeA, 'LIT1001')
  await dbOrder('gid://test/Order/aff-remi1', storeB, 'REMI1001')
})

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.fetchSheetCsv.mockImplementation(async (url: string) => (url.includes('aff1')
    ? 'Order,Tracking\nLIT1001,TRK1\nLIT1002,TRK2\nREMI1001,TRK3\nZZZ9,TRK4\n'
    : 'Order,Tracking\nLIT1001_2,TRK5\nREMI1002,TRK6\nZZZ9,TRK4\n'))
  mocks.fetchFulfillmentOrders.mockImplementation(async () => new Map())
  if (storeC) await prisma.shopifyStore.deleteMany({ where: { id: storeC } })
  storeC = ''
})

afterAll(async () => { await cleanup() })

const askedFor = () => Object.fromEntries(mocks.fetchFulfillmentOrders.mock.calls.map(c => [c[0], [...c[2]].sort()]))

describe('runAutoFulfillForStores', () => {
  it('reads each sheet once and asks each store only about the orders carrying its prefix', async () => {
    const { results, summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    expect(mocks.fetchSheetCsv).toHaveBeenCalledTimes(SHEETS.length)
    expect(askedFor()).toEqual({ [SHOP_A]: ['LIT1001', 'LIT1002'], [SHOP_B]: ['REMI1001', 'REMI1002'] })
    expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, true]])

    const names = summary!.rows.map(r => r.baseOrder)
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual(['LIT1001', 'LIT1002', 'REMI1001', 'REMI1002', 'ZZZ9'])
    expect(summary!.rows.find(r => r.baseOrder === 'LIT1001')).toMatchObject({ shop: SHOP_A })
    expect(summary!.rows.find(r => r.baseOrder === 'REMI1001')).toMatchObject({ shop: SHOP_B })
    expect(summary).toMatchObject({ ordersChecked: 5, notFound: 4, errored: 1, fulfilled: 0 })
  })

  it('reports a row no store owns once, as an error with no shop, and fulfils nothing', async () => {
    const { summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: true })
    const unowned = summary!.rows.filter(r => r.baseOrder === 'ZZZ9')
    expect(unowned).toHaveLength(1)
    expect(unowned[0]).toMatchObject({ status: 'error', fulfilledLines: 0 })
    expect(unowned[0].shop).toBeUndefined()
    expect(unowned[0].message).toContain('tiền tố')
    expect(mocks.createFulfillment).not.toHaveBeenCalled()
  })

  it('counts a sheet that failed to download once, not once per store', async () => {
    mocks.fetchSheetCsv.mockImplementation(async (url: string) => {
      if (url.includes('aff2')) throw new Error('HTTP 403')
      return 'Order,Tracking\nLIT1001,TRK1\nREMI1001,TRK3\n'
    })
    const { summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    const sheetErrors = summary!.rows.filter(r => r.baseOrder.startsWith('(sheet:'))
    expect(sheetErrors).toHaveLength(1)
    expect(sheetErrors[0].message).toContain('HTTP 403')
    expect(summary).toMatchObject({ ordersChecked: 2, errored: 1 })
  })

  it('a store without an order prefix takes no sheet rows, and a row that matches no prefix is still reported', async () => {
    storeC = (await prisma.shopifyStore.create({ data: { shop: SHOP_C, connectedAt: new Date('2026-09-03') } })).id
    await saveStoreCredential(storeC, { authMode: 'TOKEN', accessToken: 'token-aff-c' })
    const { results } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
    expect(results.map(r => r.shop)).toEqual([SHOP_A, SHOP_B, SHOP_C])
    expect(Object.keys(askedFor()).sort()).toEqual([SHOP_A, SHOP_B])
  })

  it('one store failing leaves the other store its own rows', async () => {
    await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: null } })
    try {
      const { results, summary } = await runAutoFulfillForStores({ sheets: SHEETS, minAgeDays: 5, apply: false })
      expect(results.map(r => [r.shop, r.ok])).toEqual([[SHOP_A, true], [SHOP_B, false]])
      expect(summary!.rows.filter(r => r.shop === SHOP_A).map(r => r.baseOrder).sort()).toEqual(['LIT1001', 'LIT1002'])
    } finally {
      await prisma.shopifyStoreCredential.update({ where: { storeId: storeB }, data: { accessToken: 'token-aff-b' } })
    }
  })
})

describe('orderNameHasPrefix', () => {
  it('needs the prefix followed by a digit, ignores case and the leading #', () => {
    expect(orderNameHasPrefix('LIT4665', 'LIT')).toBe(true)
    expect(orderNameHasPrefix('#lit2362R1', 'LIT')).toBe(true)
    expect(orderNameHasPrefix('LITE123', 'LIT')).toBe(false)
    expect(orderNameHasPrefix('REMI1', 'LIT')).toBe(false)
    expect(orderNameHasPrefix('LIT1', null)).toBe(false)
    expect(orderNameHasPrefix('LIT1', '')).toBe(false)
  })
})
