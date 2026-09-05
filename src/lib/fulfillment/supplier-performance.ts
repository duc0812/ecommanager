import { statusBucket } from '@/lib/tracking/status-bucket'

// Supplier delivery-time analytics over recently-delivered shipments. Milestones come
// from the ParcelPanel checkpoints stored on each Shipment:
//   placedAt    — Order.placedAt
//   firstScanAt — earliest checkpoint (Info Received / first tracking event)
//   inTransitAt — earliest checkpoint that buckets to IN_TRANSIT (first real movement)
//   deliveredAt — the delivery time (lastCheckpointAt when DELIVERED)
// Times from ParcelPanel checkpoints may lack a timezone, so we report whole-ish days.

const DAY_MS = 86_400_000

// ParcelPanel checkpoint times can be timezone-less ('2026-09-05T16:27:09'); JS would
// parse those in server-local time, so day-level deltas would shift with the deployment
// timezone. Force UTC when no offset is present so parsing is deployment-stable. (A fixed
// sub-day bias vs the UTC Order.placedAt remains — acceptable at day granularity.)
export function parseTs(s: string | null | undefined): Date | null {
  if (!s) return null
  const str = String(s).trim()
  const hasTz = /[zZ]$|[+-]\d\d:?\d\d$/.test(str)
  const d = new Date(hasTz ? str : `${str}Z`)
  return isNaN(d.getTime()) ? null : d
}

export type CheckpointMilestones = { firstScanAt: Date | null; inTransitAt: Date | null; deliveredAt: Date | null }

export function checkpointMilestones(checkpointsJson: string | null | undefined): CheckpointMilestones {
  const none: CheckpointMilestones = { firstScanAt: null, inTransitAt: null, deliveredAt: null }
  if (!checkpointsJson) return none
  let arr: any
  try { arr = JSON.parse(checkpointsJson) } catch { return none }
  if (!Array.isArray(arr)) return none

  let firstScanAt: Date | null = null
  let inTransitAt: Date | null = null
  let latestAt: Date | null = null
  for (const c of arr) {
    const t = parseTs(c?.time)
    if (!t) continue
    if (!firstScanAt || t < firstScanAt) firstScanAt = t
    if (!latestAt || t > latestAt) latestAt = t
    if (statusBucket(c?.status) === 'IN_TRANSIT' && (!inTransitAt || t < inTransitAt)) inTransitAt = t
  }
  // Delivered = the last (newest) checkpoint on a delivered shipment.
  return { firstScanAt, inTransitAt, deliveredAt: latestAt }
}

export type PerfShipment = {
  supplierId: string | null
  supplierName: string
  placedAt: Date | null
  deliveredAt: Date | null
  checkpointsJson: string | null
}

export type PerfMetric = { avgDays: number | null; n: number }
export type SupplierPerfRow = {
  supplierId: string | null
  supplierName: string
  deliveredCount: number
  placedToInTransit: PerfMetric   // #1 placed → in-transit
  inTransitToDelivered: PerfMetric // #2 in-transit → delivered
  shippingTime: PerfMetric         // #3 first tracking event → delivered (supplier shipping)
  customerReceipt: PerfMetric      // #4 placed → delivered (production + shipping)
}
export type SupplierPerfResult = {
  days: number
  overallCustomerReceipt: PerfMetric // #4 across ALL suppliers
  suppliers: SupplierPerfRow[]
}

const diffDays = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / DAY_MS

function avgMetric(values: number[]): PerfMetric {
  const clean = values.filter(v => Number.isFinite(v) && v >= 0)
  if (clean.length === 0) return { avgDays: null, n: 0 }
  const sum = clean.reduce((s, v) => s + v, 0)
  return { avgDays: Math.round((sum / clean.length) * 10) / 10, n: clean.length }
}

// Aggregate per supplier. `shipments` should already be limited to the desired window
// (delivered within `days`). Each metric averages only over shipments that have both of
// its endpoints, so a missing in-transit checkpoint just lowers that metric's sample n.
export function computeSupplierPerformance(shipments: PerfShipment[], days: number): SupplierPerfResult {
  type Acc = { name: string; delivered: number; d1: number[]; d2: number[]; d3: number[]; d4: number[] }
  const bySupplier = new Map<string, Acc>()
  const overallD4: number[] = []

  for (const s of shipments) {
    const { firstScanAt, inTransitAt, deliveredAt: cpDelivered } = checkpointMilestones(s.checkpointsJson)
    const deliveredAt = cpDelivered ?? s.deliveredAt
    if (!deliveredAt || isNaN(deliveredAt.getTime())) continue
    const key = s.supplierId ?? '__none__'
    const acc = bySupplier.get(key) ?? { name: s.supplierName || 'Chưa gán supplier', delivered: 0, d1: [], d2: [], d3: [], d4: [] }
    acc.delivered++

    const dt = deliveredAt.getTime()
    if (inTransitAt && s.placedAt) acc.d1.push(diffDays(s.placedAt, inTransitAt))
    // Skip transit deltas whose start == the delivery event (single/degenerate checkpoint):
    // that's "shipping time unknown", not a genuine 0-day shipment.
    if (inTransitAt && inTransitAt.getTime() !== dt) acc.d2.push(diffDays(inTransitAt, deliveredAt))
    if (firstScanAt && firstScanAt.getTime() !== dt) acc.d3.push(diffDays(firstScanAt, deliveredAt))
    if (s.placedAt) {
      const d4 = diffDays(s.placedAt, deliveredAt)
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
  // Slowest customer-receipt first so the worst suppliers surface at the top.
  suppliers.sort((x, y) => (y.customerReceipt.avgDays ?? -1) - (x.customerReceipt.avgDays ?? -1))

  return { days, overallCustomerReceipt: avgMetric(overallD4), suppliers }
}
