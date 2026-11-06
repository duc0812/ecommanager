import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbOrders: any[] = []
const pushRows: any[] = []
const printRows: any[] = []
vi.mock('@/lib/db', () => ({ prisma: {
  order: { findMany: vi.fn(async () => dbOrders), update: vi.fn() }, supplierOrderPush: { findMany: vi.fn(async () => pushRows) },
  supplier: { findMany: vi.fn(async () => [{ id: 'sm', name: 'Mangoshao' }, { id: 'sj', name: 'Jomall' }]) }, designArtwork: { findMany: vi.fn(async () => printRows) },
} }))
vi.mock('./parse-sheet', async (orig) => ({
  ...(await orig<typeof import('./parse-sheet')>()),
  fetchSheetCsv: vi.fn(async () => 'Order,Tracking\nLIT1001,TRK1\nLIT1002,TRK2\nLIT1003,TRK3\n'),
}))
vi.mock('@/lib/shopify-orders', () => ({
  createFulfillment: vi.fn(),
  fetchOrderFulfillmentOrdersByNames: vi.fn(async (_s: string, _t: string, names: string[], _v: unknown, onBatch?: (d: number, t: number) => void) => {
    if (names.length) onBatch?.(names.length, names.length)
    return new Map()
  }),
}))

import { runAutoFulfill, settleFromDb } from './auto-fulfill'
import { createFulfillment, fetchOrderFulfillmentOrdersByNames } from '@/lib/shopify-orders'

const NOW = new Date('2026-10-28T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const SHEET = { id: '1', name: 'A', url: 'https://docs.google.com/spreadsheets/d/abc123/edit', enabled: true }
const dbOrder = (name: string, placedAt: Date, fulfillmentStatus: string | null) =>
  ({ id: name, shopifyOrderNumber: `#${name}`, placedAt, pipelineStatus: null, fulfillmentStatus, shipments: [], lines: [], supplierPushes: [] })

beforeEach(() => { vi.clearAllMocks(); dbOrders.length = 0; pushRows.length = 0; printRows.length = 0 })

describe('runAutoFulfill', () => {
  it('reports each sheet read and the Shopify batches before evaluating orders', async () => {
    const events: string[] = []
    await runAutoFulfill({
      shop: 's', accessToken: 't', storeId: 'st', minAgeDays: 5, apply: false, now: NOW,
      sheets: [SHEET, { ...SHEET, id: '2' }, { ...SHEET, id: '3', enabled: false }],
      onStage: (stage, done, total) => events.push(`${stage} ${done}/${total}`),
      onProgress: (done, total) => events.push(`progress ${done}/${total}`),
    })
    expect(events.slice(0, 3)).toEqual(['sheets 0/2', 'sheets 1/2', 'shopify 3/3'])
    expect(events.at(-1)).toBe('progress 3/3')
  })

  it('settles fulfilled and too-recent orders from the DB and asks Shopify only about the rest', async () => {
    dbOrders.push(dbOrder('LIT1001', daysAgo(20), 'FULFILLED'), dbOrder('LIT1002', daysAgo(2), null), dbOrder('LIT1003', daysAgo(20), 'UNFULFILLED'))
    const r = await runAutoFulfill({ shop: 's', accessToken: 't', storeId: 'st', minAgeDays: 5, apply: false, now: NOW, sheets: [SHEET] })
    expect((fetchOrderFulfillmentOrdersByNames as any).mock.calls[0][2]).toEqual(['LIT1003'])
    expect(r.alreadyFulfilled).toBe(1)
    expect(r.tooRecent).toBe(1)
    expect(r.notFound).toBe(1)
  })
})

describe('whole-order row checked against the order lines', () => {
  const twoLines = (second: Record<string, unknown>) => {
    // Each line exported to its own supplier (Auto Fulfilled fulfils a product line only after it went to its supplier).
    const line = (id: string, more: Record<string, unknown>) => {
      const l = { id: `ol-${id}`, shopifyLineId: id, sku: `SKU-${id}`, productTitle: 'Hoodie', shopifyProductType: 'Hoodie', linePosition: Number(id.slice(1)), resolvedSupplierId: 'sm', designDriveLink: 'https://x', ...more }
      return { ...l, exportedToSupplierId: l.resolvedSupplierId, exportedAt: daysAgo(15) }
    }
    dbOrders.push({ ...dbOrder('LIT1003', daysAgo(20), 'UNFULFILLED'), trelloCardUrl: null, lines: [line('L1', {}), line('L2', second)] })
    ;(fetchOrderFulfillmentOrdersByNames as any).mockResolvedValueOnce(new Map([['LIT1003', { displayFulfillmentStatus: 'UNFULFILLED', createdAt: daysAgo(20).toISOString(), fulfillmentOrders: [
      { id: 'FO', status: 'OPEN', lineItems: [{ id: 'A', remainingQuantity: 1, shopifyLineId: 'L1', sku: 'X' }, { id: 'B', remainingQuantity: 1, shopifyLineId: 'L2', sku: 'Y' }] },
    ] }]]))
  }
  const run = () => runAutoFulfill({ shop: 's', accessToken: 't', storeId: 'st', minAgeDays: 5, apply: true, now: NOW, sheets: [{ ...SHEET, name: 'Mangoshao' }] })

  it('does not fulfill when the row comes from another supplier than a line', async () => {
    twoLines({ resolvedSupplierId: 'sj' })
    const r = await run()
    expect(createFulfillment).not.toHaveBeenCalled()
    const row = r.rows.find(x => x.baseOrder === 'LIT1003')
    expect(row?.status).toBe('needs_manual')
    expect(row?.message).toContain('xưởng Jomall')
  })
  it('does not fulfill when a line has no file, and a print on the line counts as a file', async () => {
    twoLines({ designDriveLink: null })
    expect((await run()).rows.find(x => x.baseOrder === 'LIT1003')?.message).toContain('chưa có file')
    expect(createFulfillment).not.toHaveBeenCalled()

    dbOrders.length = 0
    twoLines({ designDriveLink: null })
    printRows.push({ orderId: 'LIT1003', shopifyLineId: 'L2' })
    ;(createFulfillment as any).mockResolvedValue({ ok: true, fulfillmentId: 'F1' })
    expect((await run()).rows.find(x => x.baseOrder === 'LIT1003')?.status).toBe('will_fulfill')
    expect(createFulfillment).toHaveBeenCalledTimes(1)
  })
})

describe('settleFromDb', () => {
  it('leaves orders the DB cannot settle to Shopify', () => {
    expect(settleFromDb('A', undefined, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: null, fulfillmentStatus: 'FULFILLED' }, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: daysAgo(9), fulfillmentStatus: 'PARTIALLY_FULFILLED' }, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: daysAgo(9), fulfillmentStatus: 'fulfilled' }, NOW, 5)?.status).toBe('already_fulfilled')
  })
})

describe('API-pushed tracking', () => {
  it('adds tracked supplier shipments as rows and lets them past the min-age gate', async () => {
    pushRows.push({ supplierId: 'pg', order: { shopifyOrderNumber: '#LIT2000', shipments: [
      { lineKey: 'LIT2000_1', trackingNumber: ' 9400TRK ', supplierId: 'pg' },
      { lineKey: 'LIT2000_2', trackingNumber: 'OTHER', supplierId: 'someone-else' },
    ] } })
    dbOrders.push(dbOrder('LIT2000', daysAgo(2), 'UNFULFILLED'))
    const r = await runAutoFulfill({ shop: 's', accessToken: 't', storeId: 'st', minAgeDays: 7, apply: false, now: NOW, sheets: [] })
    expect((fetchOrderFulfillmentOrdersByNames as any).mock.calls[0][2]).toEqual(['LIT2000'])
    expect(r.ordersChecked).toBe(1)
    expect(r.tooRecent).toBe(0)
    expect(r.notFound).toBe(1)
  })
})
