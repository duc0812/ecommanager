import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderFindMany: vi.fn(async (_args?: any) => [] as any[]),
  getTrelloConfig: vi.fn(async () => ({
    apiKey: 'k', token: 't', boardId: 'b', listId: 'l', doneListId: 'd', syncFromOrderName: '',
  })),
  getShopifyConnection: vi.fn(async () => ({ shop: 'x.myshopify.com', token: 'tok' })),
  fetchOrderLinePropsByNames: vi.fn(async () => new Map()),
  getCardDesc: vi.fn(async () => ''),
  updateCardDesc: vi.fn(async () => {}),
}))

vi.mock('@/lib/db', () => ({ prisma: { order: { findMany: mocks.orderFindMany } } }))
vi.mock('@/lib/trello', () => ({
  getTrelloConfig: mocks.getTrelloConfig,
  getCardDesc: mocks.getCardDesc,
  updateCardDesc: mocks.updateCardDesc,
}))
vi.mock('@/lib/token-store', () => ({ getShopifyConnection: mocks.getShopifyConnection }))
vi.mock('@/lib/shopify-orders', () => ({ fetchOrderLinePropsByNames: mocks.fetchOrderLinePropsByNames }))

import { POST } from '@/app/api/trello/backfill-custom-info/route'

const post = (body: any) =>
  POST(new Request('http://x/api/trello/backfill-custom-info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

describe('POST /api/trello/backfill-custom-info order targeting', () => {
  beforeEach(() => { mocks.orderFindMany.mockClear() })

  it('named orders select by name and drop the placedAt window', async () => {
    await post({ orderNames: ['LIT4024', '#LIT4031'], dryRun: true })
    const where = (mocks.orderFindMany.mock.calls[0][0] as any).where
    expect(where.shopifyOrderNumber).toEqual({ in: ['#LIT4024', '#LIT4031'] })
    expect(where.placedAt).toBeUndefined()
    expect(where.trelloCardId).toEqual({ not: null })
  })

  it('normalizes "#", case and duplicates', async () => {
    await post({ orderNames: [' lit4024 ', '#LIT4024', 'LIT4031'], dryRun: true })
    expect((mocks.orderFindMany.mock.calls[0][0] as any).where.shopifyOrderNumber)
      .toEqual({ in: ['#LIT4024', '#LIT4031'] })
  })

  it('falls back to the time window when no order is named', async () => {
    await post({ sinceDays: 30, dryRun: true })
    const where = (mocks.orderFindMany.mock.calls[0][0] as any).where
    expect(where.shopifyOrderNumber).toBeUndefined()
    expect(where.placedAt.gte).toBeInstanceOf(Date)
  })

  it('reports a named order that has no card row, instead of silently doing nothing', async () => {
    mocks.orderFindMany.mockResolvedValueOnce([{ shopifyOrderNumber: '#LIT4024', trelloCardId: 'c1' }])
    const body = await (await post({ orderNames: ['LIT4024', 'LIT9999'], dryRun: true })).json()
    expect(body.notInDb).toEqual(['#LIT9999'])
    expect(body.sinceDays).toBeNull()
  })
})
