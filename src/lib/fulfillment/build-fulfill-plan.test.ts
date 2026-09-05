import { describe, it, expect } from 'vitest'
import { normalizeBaseOrder, orderLineKey, groupByOrder, buildFulfillmentPlan } from './build-fulfill-plan'

const NOW = new Date('2026-09-05T00:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe('normalizeBaseOrder / orderLineKey', () => {
  it('strips # and sub-order suffix for base', () => {
    expect(normalizeBaseOrder('#LIT2604_2')).toBe('LIT2604')
    expect(normalizeBaseOrder('LIT2604')).toBe('LIT2604')
    expect(normalizeBaseOrder('#LIT2713_2_1')).toBe('LIT2713')
  })
  it('lineKey strips only the leading #', () => {
    expect(orderLineKey('#LIT2604_2')).toBe('LIT2604_2')
    expect(orderLineKey('#LIT2604')).toBe('LIT2604')
  })
})

describe('groupByOrder', () => {
  it('groups rows under their base order', () => {
    const g = groupByOrder([
      { orderToken: '#LIT1_1', tracking: 'AA' },
      { orderToken: '#LIT1_2', tracking: 'AA' },
      { orderToken: '#LIT2', tracking: 'BB' },
    ])
    expect(g.get('LIT1')).toEqual([{ lineKey: 'LIT1_1', tracking: 'AA' }, { lineKey: 'LIT1_2', tracking: 'AA' }])
    expect(g.get('LIT2')).toEqual([{ lineKey: 'LIT2', tracking: 'BB' }])
  })
})

const foOneOpenLine = [{ id: 'fo1', status: 'OPEN', lineItems: [
  { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
] }]

describe('buildFulfillmentPlan', () => {
  const base = { displayFulfillmentStatus: 'UNFULFILLED', now: NOW, minAgeDays: 5 }

  it('not_found when Shopify order missing', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: null, placedAt: days(10) })
    expect(p.status).toBe('not_found')
  })

  it('too_recent when younger than the age gate', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, placedAt: days(4) })
    expect(p.status).toBe('too_recent')
    expect(p.ageDays).toBe(4)
  })

  it('will_fulfill at exactly the age threshold, whole-order one tracking', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, placedAt: days(5) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([{ fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: [] }])
  })

  it('already_fulfilled when Shopify reports FULFILLED', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: [], displayFulfillmentStatus: 'FULFILLED', placedAt: days(10) })
    expect(p.status).toBe('already_fulfilled')
  })

  it('splits by tracking per line, mapping via shipments', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      { id: 'foli-B', remainingQuantity: 1, shopifyLineId: 'gid://li/B', sku: 'B' },
    ] }]
    const shipments = [
      { id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' },
      { id: 's2', lineKey: 'LIT1_2', shopifyLineId: 'gid://li/B' },
    ]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments, fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('will_fulfill')
    expect(p.fulfillments).toEqual([
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-A', quantity: 1 }], tracking: 'AA', shipmentIds: ['s1'] },
      { fulfillmentOrderId: 'fo1', lineItems: [{ id: 'foli-B', quantity: 1 }], tracking: 'BB', shipmentIds: ['s2'] },
    ])
  })

  it('needs_manual when a sub-order line cannot be mapped', () => {
    const fo = [{ id: 'fo1', status: 'OPEN', lineItems: [
      { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
    ] }]
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [
      { lineKey: 'LIT1_1', tracking: 'AA' },
      { lineKey: 'LIT1_2', tracking: 'BB' },
    ], shipments: [{ id: 's1', lineKey: 'LIT1_1', shopifyLineId: 'gid://li/A' }], fulfillmentOrders: fo, placedAt: days(9) })
    expect(p.status).toBe('needs_manual')
  })

  it('needs_manual when order date is unknown', () => {
    const p = buildFulfillmentPlan({ ...base, baseOrder: 'LIT1', rows: [{ lineKey: 'LIT1', tracking: 'AA' }], shipments: [], fulfillmentOrders: foOneOpenLine, placedAt: null })
    expect(p.status).toBe('needs_manual')
  })
})
