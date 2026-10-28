import { describe, it, expect, vi, beforeEach } from 'vitest'

const dbOrders: any[] = []
vi.mock('@/lib/db', () => ({ prisma: { order: { findMany: vi.fn(async () => dbOrders) } } }))
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
import { fetchOrderFulfillmentOrdersByNames } from '@/lib/shopify-orders'

const NOW = new Date('2026-10-28T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
const SHEET = { id: '1', name: 'A', url: 'https://docs.google.com/spreadsheets/d/abc123/edit', enabled: true, storeBase: 'https://litzzy.com' }
const dbOrder = (name: string, placedAt: Date, fulfillmentStatus: string | null) =>
  ({ id: name, shopifyOrderNumber: `#${name}`, placedAt, pipelineStatus: null, fulfillmentStatus, shipments: [], lines: [] })

beforeEach(() => { vi.clearAllMocks(); dbOrders.length = 0 })

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

describe('settleFromDb', () => {
  it('leaves orders the DB cannot settle to Shopify', () => {
    expect(settleFromDb('A', undefined, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: null, fulfillmentStatus: 'FULFILLED' }, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: daysAgo(9), fulfillmentStatus: 'PARTIALLY_FULFILLED' }, NOW, 5)).toBeNull()
    expect(settleFromDb('A', { placedAt: daysAgo(9), fulfillmentStatus: 'fulfilled' }, NOW, 5)?.status).toBe('already_fulfilled')
  })
})
