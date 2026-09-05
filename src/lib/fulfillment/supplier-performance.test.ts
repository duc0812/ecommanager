import { describe, it, expect } from 'vitest'
import { checkpointMilestones, computeSupplierPerformance, parseTs, type PerfShipment } from './supplier-performance'

describe('parseTs', () => {
  it('parses a timezone-less checkpoint time as UTC (deployment-stable)', () => {
    expect(parseTs('2026-09-05T16:27:09')).toEqual(new Date('2026-09-05T16:27:09Z'))
  })
  it('keeps an explicit offset / Z', () => {
    expect(parseTs('2026-09-05T06:23:46-06:00')).toEqual(new Date('2026-09-05T12:23:46Z'))
    expect(parseTs('2026-09-05T00:00:00Z')).toEqual(new Date('2026-09-05T00:00:00Z'))
  })
  it('returns null for empty/invalid', () => {
    expect(parseTs(null)).toBeNull()
    expect(parseTs('nope')).toBeNull()
  })
})

describe('checkpointMilestones', () => {
  it('finds earliest checkpoint, earliest IN_TRANSIT, and latest (delivered)', () => {
    const cp = JSON.stringify([
      { time: '2026-09-08T00:00:00Z', status: 'DELIVERED', desc: 'delivered' },
      { time: '2026-09-03T00:00:00Z', status: 'IN_TRANSIT', desc: 'moving' },
      { time: '2026-09-02T00:00:00Z', status: 'INFO_RECEIVED', desc: 'label created' },
      { time: '2026-09-04T00:00:00Z', status: 'IN_TRANSIT', desc: 'arrived' },
    ])
    const m = checkpointMilestones(cp)
    expect(m.firstScanAt).toEqual(new Date('2026-09-02T00:00:00Z'))
    expect(m.inTransitAt).toEqual(new Date('2026-09-03T00:00:00Z'))
    expect(m.deliveredAt).toEqual(new Date('2026-09-08T00:00:00Z'))
  })

  it('returns nulls for missing / invalid input', () => {
    expect(checkpointMilestones(null)).toEqual({ firstScanAt: null, inTransitAt: null, deliveredAt: null })
    expect(checkpointMilestones('not json')).toEqual({ firstScanAt: null, inTransitAt: null, deliveredAt: null })
    const infoOnly = JSON.stringify([{ time: '2026-09-02T00:00:00Z', status: 'INFO_RECEIVED' }])
    expect(checkpointMilestones(infoOnly)).toEqual({ firstScanAt: new Date('2026-09-02T00:00:00Z'), inTransitAt: null, deliveredAt: new Date('2026-09-02T00:00:00Z') })
  })
})

describe('computeSupplierPerformance', () => {
  const cp = (events: [string, string][]) => JSON.stringify(events.map(([time, status]) => ({ time, status })))
  const placed = new Date('2026-09-01T00:00:00Z')

  const shipments: PerfShipment[] = [
    // SupA #1: firstScan 09-02, in-transit 09-03, delivered 09-08 → d1=2 d2=5 d3=6 d4=7
    { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null,
      checkpointsJson: cp([['2026-09-08T00:00:00Z', 'DELIVERED'], ['2026-09-03T00:00:00Z', 'IN_TRANSIT'], ['2026-09-02T00:00:00Z', 'INFO_RECEIVED']]) },
    // SupA #2: no in-transit; firstScan 09-02, delivered 09-06 → d3=4 d4=5
    { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null,
      checkpointsJson: cp([['2026-09-06T00:00:00Z', 'DELIVERED'], ['2026-09-02T00:00:00Z', 'INFO_RECEIVED']]) },
    // SupB: firstScan 09-02, in-transit 09-03, delivered 09-11 → d1=2 d2=8 d3=9 d4=10
    { supplierId: 'B', supplierName: 'SupB', placedAt: placed, deliveredAt: null,
      checkpointsJson: cp([['2026-09-11T00:00:00Z', 'DELIVERED'], ['2026-09-03T00:00:00Z', 'IN_TRANSIT'], ['2026-09-02T00:00:00Z', 'INFO_RECEIVED']]) },
  ]

  it('averages the four metrics per supplier, skipping shipments missing a milestone', () => {
    const r = computeSupplierPerformance(shipments, 30)
    const a = r.suppliers.find(s => s.supplierId === 'A')!
    expect(a.deliveredCount).toBe(2)
    expect(a.placedToInTransit).toEqual({ avgDays: 2, n: 1 })
    expect(a.inTransitToDelivered).toEqual({ avgDays: 5, n: 1 })
    expect(a.shippingTime).toEqual({ avgDays: 5, n: 2 })    // (6 + 4) / 2
    expect(a.customerReceipt).toEqual({ avgDays: 6, n: 2 }) // (7 + 5) / 2
    expect(r.suppliers.find(s => s.supplierId === 'B')!.customerReceipt).toEqual({ avgDays: 10, n: 1 })
  })

  it('reports overall customer-receipt across all suppliers and sorts slowest first', () => {
    const r = computeSupplierPerformance(shipments, 30)
    expect(r.days).toBe(30)
    expect(r.overallCustomerReceipt).toEqual({ avgDays: 7.3, n: 3 }) // (7 + 5 + 10) / 3
    expect(r.suppliers[0].supplierId).toBe('B')
  })

  it('excludes shipping/transit time when the only checkpoint is the delivery scan (no real first scan)', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'C', supplierName: 'SupC', placedAt: placed, deliveredAt: null,
        checkpointsJson: cp([['2026-09-05T00:00:00Z', 'DELIVERED']]) },
    ], 30)
    const c = r.suppliers[0]
    expect(c.shippingTime).toEqual({ avgDays: null, n: 0 }) // firstScan == delivered → excluded
    expect(c.inTransitToDelivered).toEqual({ avgDays: null, n: 0 })
    expect(c.customerReceipt).toEqual({ avgDays: 4, n: 1 }) // placed → delivered still counts
  })

  it('ignores shipments with no checkpoints and no delivered date', () => {
    const r = computeSupplierPerformance([
      { supplierId: 'A', supplierName: 'SupA', placedAt: placed, deliveredAt: null, checkpointsJson: null },
    ], 30)
    expect(r.suppliers).toEqual([])
    expect(r.overallCustomerReceipt).toEqual({ avgDays: null, n: 0 })
  })
})
