import { describe, it, expect } from 'vitest'
import { parseTs, ppWallClock, checkpointMilestones, parsePpTiming, computeSupplierPerformance, type PerfShipment } from './supplier-performance'

describe('parseTs', () => {
  it('parses timezone-less as UTC; keeps explicit offset/Z', () => {
    expect(parseTs('2026-09-05T16:27:09')).toEqual(new Date('2026-09-05T16:27:09Z'))
    expect(parseTs('2026-09-05T06:23:46-06:00')).toEqual(new Date('2026-09-05T12:23:46Z'))
    expect(parseTs(null)).toBeNull()
    expect(parseTs('nope')).toBeNull()
  })
})

describe('ppWallClock', () => {
  it('compares PP times as wall-clock (strips any offset, parses as UTC)', () => {
    // The -06:00 is dropped so it lines up with a TZ-less PP time in the same store TZ.
    expect(ppWallClock('2026-09-01T00:00:00-06:00')).toEqual(new Date('2026-09-01T00:00:00Z'))
    expect(ppWallClock('2026-09-03T00:00:00')).toEqual(new Date('2026-09-03T00:00:00Z'))
    expect(ppWallClock('2026-09-03T00:00:00Z')).toEqual(new Date('2026-09-03T00:00:00Z'))
    expect(ppWallClock(null)).toBeNull()
  })
})

describe('parsePpTiming', () => {
  it('parses the stored PP timing JSON', () => {
    const t = parsePpTiming(JSON.stringify({ orderDate: '2026-09-01T00:00:00Z', fulfillmentDate: '2026-09-02T00:00:00Z', pickupDate: '2026-09-03T00:00:00Z', deliveryDate: '2026-09-10T00:00:00Z', transitTime: 6 }))
    expect(t.orderDate).toEqual(new Date('2026-09-01T00:00:00Z'))
    expect(t.pickupDate).toEqual(new Date('2026-09-03T00:00:00Z'))
    expect(t.deliveryDate).toEqual(new Date('2026-09-10T00:00:00Z'))
    expect(t.transitTime).toBe(6)
  })
  it('returns nulls for missing/invalid', () => {
    expect(parsePpTiming(null)).toEqual({ orderDate: null, fulfillmentDate: null, pickupDate: null, deliveryDate: null, transitTime: null })
    expect(parsePpTiming('x')).toEqual({ orderDate: null, fulfillmentDate: null, pickupDate: null, deliveryDate: null, transitTime: null })
  })
})

describe('checkpointMilestones', () => {
  it('earliest, earliest IN_TRANSIT, and latest (delivered)', () => {
    const cp = JSON.stringify([
      { time: '2026-09-08T00:00:00Z', status: 'DELIVERED' },
      { time: '2026-09-03T00:00:00Z', status: 'IN_TRANSIT' },
      { time: '2026-09-02T00:00:00Z', status: 'INFO_RECEIVED' },
    ])
    expect(checkpointMilestones(cp)).toEqual({
      firstScanAt: new Date('2026-09-02T00:00:00Z'),
      inTransitAt: new Date('2026-09-03T00:00:00Z'),
      deliveredAt: new Date('2026-09-08T00:00:00Z'),
    })
  })
})

describe('computeSupplierPerformance — PP timing (primary)', () => {
  const placed = new Date('2026-08-01T00:00:00Z')
  const pp = JSON.stringify({ orderDate: '2026-09-01T00:00:00Z', fulfillmentDate: '2026-09-02T00:00:00Z', pickupDate: '2026-09-03T00:00:00Z', deliveryDate: '2026-09-10T00:00:00Z', transitTime: 6 })

  it('uses PP fields and prefers PP transit_time over derived pickup→delivery', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null, checkpointsJson: null, ppTimingJson: pp },
    ], 30)
    const a = r.suppliers[0]
    expect(a.placedToInTransit).toEqual({ avgDays: 2, n: 1 })     // order 09-01 → pickup 09-03
    expect(a.inTransitToDelivered).toEqual({ avgDays: 6, n: 1 })  // transit_time=6 (NOT pickup→delivery=7)
    expect(a.shippingTime).toEqual({ avgDays: 8, n: 1 })          // fulfillment 09-02 → delivery 09-10
    expect(a.customerReceipt).toEqual({ avgDays: 9, n: 1 })       // order 09-01 → delivery 09-10
    expect(r.overallCustomerReceipt).toEqual({ avgDays: 9, n: 1 })
  })
})

describe('computeSupplierPerformance — checkpoint fallback', () => {
  const placed = new Date('2026-09-01T00:00:00Z')
  const cp = (events: [string, string][]) => JSON.stringify(events.map(([time, status]) => ({ time, status })))

  it('falls back to checkpoints when ppTimingJson is absent', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null, ppTimingJson: null,
        checkpointsJson: cp([['2026-09-08T00:00:00Z', 'DELIVERED'], ['2026-09-03T00:00:00Z', 'IN_TRANSIT'], ['2026-09-02T00:00:00Z', 'INFO_RECEIVED']]) },
    ], 30)
    const a = r.suppliers[0]
    expect(a.placedToInTransit).toEqual({ avgDays: 2, n: 1 })     // placed 09-01 → inTransit 09-03
    expect(a.inTransitToDelivered).toEqual({ avgDays: 5, n: 1 })  // 09-03 → 09-08
    expect(a.shippingTime).toEqual({ avgDays: 6, n: 1 })          // 09-02 → 09-08
    expect(a.customerReceipt).toEqual({ avgDays: 7, n: 1 })       // 09-01 → 09-08
  })

  it('excludes degenerate transit deltas (single delivery-only checkpoint) but keeps customer receipt', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'C', supplierName: 'SupC', placedAt: placed, deliveredAt: null, ppTimingJson: null,
        checkpointsJson: cp([['2026-09-05T00:00:00Z', 'DELIVERED']]) },
    ], 30)
    const c = r.suppliers[0]
    expect(c.shippingTime).toEqual({ avgDays: null, n: 0 })
    expect(c.inTransitToDelivered).toEqual({ avgDays: null, n: 0 })
    expect(c.customerReceipt).toEqual({ avgDays: 4, n: 1 })
  })

  it('ignores shipments with no delivered signal at all', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null, checkpointsJson: null, ppTimingJson: null },
    ], 30)
    expect(r.suppliers).toEqual([])
    expect(r.overallCustomerReceipt).toEqual({ avgDays: null, n: 0 })
  })
})
