import { describe, it, expect } from 'vitest'
import { computeWarnings, WARNING_TYPES, WARNING_META } from './order-warnings'

const now = new Date('2026-08-29T00:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000)
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000)

describe('computeWarnings', () => {
  it('W1 LATE_FULFILLMENT: >=7d old + Shopify not fulfilled + not done pipeline', () => {
    expect(computeWarnings({ placedAt: daysAgo(8), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED' }, now))
      .toEqual(['LATE_FULFILLMENT'])
  })

  it('W1 excluded when Shopify fulfilled', () => {
    expect(computeWarnings({ placedAt: daysAgo(8), fulfillmentStatus: 'FULFILLED', pipelineStatus: 'EXPORTED' }, now)).toEqual([])
  })

  it('W1 excluded when pipeline already FULFILLED/CANCELLED/REFUNDED', () => {
    for (const ps of ['FULFILLED', 'CANCELLED', 'REFUNDED']) {
      expect(computeWarnings({ placedAt: daysAgo(10), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: ps }, now)).toEqual([])
    }
  })

  it('W1 excluded when younger than 7 days', () => {
    expect(computeWarnings({ placedAt: daysAgo(6), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'EXPORTED' }, now)).toEqual([])
  })

  it('W2 STUCK_DESIGN: >=24h old + still PENDING_DESIGN', () => {
    expect(computeWarnings({ placedAt: hoursAgo(25), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'PENDING_DESIGN' }, now))
      .toEqual(['STUCK_DESIGN'])
    expect(computeWarnings({ placedAt: hoursAgo(20), fulfillmentStatus: null, pipelineStatus: 'PENDING_DESIGN' }, now)).toEqual([])
  })

  it('W3 NOT_EXPORTED: >=24h old + still READY_TO_PRODUCTION', () => {
    expect(computeWarnings({ placedAt: hoursAgo(30), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'READY_TO_PRODUCTION' }, now))
      .toEqual(['NOT_EXPORTED'])
    expect(computeWarnings({ placedAt: hoursAgo(10), fulfillmentStatus: null, pipelineStatus: 'READY_TO_PRODUCTION' }, now)).toEqual([])
  })

  it('can raise multiple warnings at once (W1 + W2)', () => {
    const w = computeWarnings({ placedAt: daysAgo(9), fulfillmentStatus: 'UNFULFILLED', pipelineStatus: 'PENDING_DESIGN' }, now)
    expect(w).toContain('LATE_FULFILLMENT')
    expect(w).toContain('STUCK_DESIGN')
    expect(w.length).toBe(2)
  })

  it('exposes ordered types with metadata', () => {
    expect(WARNING_TYPES).toEqual(['LATE_FULFILLMENT', 'STUCK_DESIGN', 'NOT_EXPORTED'])
    expect(WARNING_META.LATE_FULFILLMENT.label).toBeTruthy()
    expect(WARNING_META.NOT_EXPORTED.short).toBeTruthy()
  })
})
