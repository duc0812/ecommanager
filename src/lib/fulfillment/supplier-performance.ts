import { statusBucket } from '@/lib/tracking/status-bucket'

// Supplier delivery-time analytics over recently-delivered shipments. Primary source is
// ParcelPanel's own timing fields (ppTimingJson: orderDate/fulfillmentDate/pickupDate/
// deliveryDate/transitTime) — the same fields its Analytics dashboard uses. Falls back to
// parsing the stored checkpoints for shipments synced before those fields were captured.
const DAY_MS = 86_400_000

// Parse a timezone-less checkpoint time as UTC so day-level deltas don't shift with the
// deployment timezone (checkpoints are compared only against each other).
export function parseTs(s: string | null | undefined): Date | null {
  if (!s) return null
  const str = String(s).trim()
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(str)
  const d = new Date(hasTz ? str : `${str}Z`)
  return isNaN(d.getTime()) ? null : d
}

// PP timing strings mix TZ-annotated ('...-06:00') and TZ-less ('...') values, all in the
// store's timezone. Compare them as WALL-CLOCK (strip any offset, parse as UTC) so day
// deltas between two PP timestamps are correct regardless of the actual offset.
export function ppWallClock(s: string | null | undefined): Date | null {
  if (!s) return null
  const stripped = String(s).trim().replace(/([zZ]|[+-]\d\d:?\d\d)$/, '')
  const d = new Date(`${stripped}Z`)
  return isNaN(d.getTime()) ? null : d
}

export type CheckpointMilestones = { firstScanAt: Date | null; inTransitAt: Date | null; deliveredAt: Date | null }

export function checkpointMilestones(checkpointsJson: string | null | undefined): CheckpointMilestones {
  const none: CheckpointMilestones = { firstScanAt: null, inTransitAt: null, deliveredAt: null }
  if (!checkpointsJson) return none
  let arr: any
  try { arr = JSON.parse(checkpointsJson) } catch { return none }
  if (!Array.isArray(arr)) return none
  let firstScanAt: Date | null = null, inTransitAt: Date | null = null, latestAt: Date | null = null
  for (const c of arr) {
    const t = parseTs(c?.time)
    if (!t) continue
    if (!firstScanAt || t < firstScanAt) firstScanAt = t
    if (!latestAt || t > latestAt) latestAt = t
    if (statusBucket(c?.status) === 'IN_TRANSIT' && (!inTransitAt || t < inTransitAt)) inTransitAt = t
  }
  return { firstScanAt, inTransitAt, deliveredAt: latestAt }
}

type PpTimingParsed = { orderDate: Date | null; fulfillmentDate: Date | null; pickupDate: Date | null; deliveryDate: Date | null; transitTime: number | null }

export function parsePpTiming(ppTimingJson: string | null | undefined): PpTimingParsed {
  const none: PpTimingParsed = { orderDate: null, fulfillmentDate: null, pickupDate: null, deliveryDate: null, transitTime: null }
  if (!ppTimingJson) return none
  let o: any
  try { o = JSON.parse(ppTimingJson) } catch { return none }
  if (!o || typeof o !== 'object') return none
  return {
    orderDate: ppWallClock(o.orderDate),
    fulfillmentDate: ppWallClock(o.fulfillmentDate),
    pickupDate: ppWallClock(o.pickupDate),
    deliveryDate: ppWallClock(o.deliveryDate),
    transitTime: typeof o.transitTime === 'number' && o.transitTime >= 0 ? o.transitTime : null,
  }
}

export type PerfShipment = {
  supplierId: string | null
  supplierName: string
  placedAt: Date | null          // Order.placedAt (fallback when PP orderDate is absent)
  deliveredAt: Date | null       // fallback delivered time (lastCheckpointAt)
  checkpointsJson: string | null // fallback milestone source
  ppTimingJson: string | null    // primary source (ParcelPanel timing fields)
}

export type PerfMetric = { avgDays: number | null; n: number }
export type SupplierPerfRow = {
  supplierId: string | null
  supplierName: string
  deliveredCount: number
  placedToInTransit: PerfMetric    // #1 placed → in-transit (pickup)
  inTransitToDelivered: PerfMetric // #2 in-transit → delivered (PP transit_time)
  shippingTime: PerfMetric         // #3 fulfillment/first-scan → delivered
  customerReceipt: PerfMetric      // #4 placed → delivered
}
export type SupplierPerfResult = { days: number; overallCustomerReceipt: PerfMetric; suppliers: SupplierPerfRow[] }

const diffDays = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / DAY_MS

function avgMetric(values: number[]): PerfMetric {
  const clean = values.filter(v => Number.isFinite(v) && v >= 0)
  if (clean.length === 0) return { avgDays: null, n: 0 }
  const sum = clean.reduce((s, v) => s + v, 0)
  return { avgDays: Math.round((sum / clean.length) * 10) / 10, n: clean.length }
}

export function computeSupplierPerformance(shipments: PerfShipment[], days: number): SupplierPerfResult {
  type Acc = { name: string; delivered: number; d1: number[]; d2: number[]; d3: number[]; d4: number[] }
  const bySupplier = new Map<string, Acc>()
  const overallD4: number[] = []

  for (const s of shipments) {
    const t = parsePpTiming(s.ppTimingJson)
    const cp = checkpointMilestones(s.checkpointsJson)
    const placed = t.orderDate ?? s.placedAt
    const delivered = t.deliveryDate ?? cp.deliveredAt ?? s.deliveredAt
    if (!delivered || isNaN(delivered.getTime())) continue
    const inTransit = t.pickupDate ?? cp.inTransitAt
    const firstScan = t.fulfillmentDate ?? cp.firstScanAt

    const key = s.supplierId ?? '__none__'
    const acc = bySupplier.get(key) ?? { name: s.supplierName || 'Chưa gán supplier', delivered: 0, d1: [], d2: [], d3: [], d4: [] }
    acc.delivered++

    const dt = delivered.getTime()
    if (inTransit && placed) acc.d1.push(diffDays(placed, inTransit))
    // #2: prefer PP's own transit_time; else derive, skipping the degenerate same-timestamp case.
    if (t.transitTime != null) acc.d2.push(t.transitTime)
    else if (inTransit && inTransit.getTime() !== dt) acc.d2.push(diffDays(inTransit, delivered))
    if (firstScan && firstScan.getTime() !== dt) acc.d3.push(diffDays(firstScan, delivered))
    if (placed) {
      const d4 = diffDays(placed, delivered)
      acc.d4.push(d4)
      overallD4.push(d4)
    }
    bySupplier.set(key, acc)
  }

  const suppliers: SupplierPerfRow[] = Array.from(bySupplier.entries()).map(([key, a]) => ({
    supplierId: key === '__none__' ? null : key,
    supplierName: a.name,
    deliveredCount: a.delivered,
    placedToInTransit: avgMetric(a.d1),
    inTransitToDelivered: avgMetric(a.d2),
    shippingTime: avgMetric(a.d3),
    customerReceipt: avgMetric(a.d4),
  }))
  suppliers.sort((x, y) => (y.customerReceipt.avgDays ?? -1) - (x.customerReceipt.avgDays ?? -1))

  return { days, overallCustomerReceipt: avgMetric(overallD4), suppliers }
}
