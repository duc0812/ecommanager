// Multi-type order warnings (a dimension separate from pipeline status).
// Thresholds are measured from placedAt (order age) because we don't store a
// per-status transition timestamp. Keep the where-clause builder in
// repos/orders.ts (warningTypeWhere) in sync with this pure logic.

export type WarningType = 'LATE_FULFILLMENT' | 'STUCK_DESIGN' | 'NOT_EXPORTED'

export const WARNING_TYPES: WarningType[] = ['LATE_FULFILLMENT', 'STUCK_DESIGN', 'NOT_EXPORTED']

export const WARNING_META: Record<WarningType, { label: string; short: string; tone: string; dot: string }> = {
  LATE_FULFILLMENT: { label: 'Trễ fulfillment (>7 ngày)', short: 'Trễ fulfill', tone: 'bg-red-100 text-red-900', dot: 'bg-red-500' },
  STUCK_DESIGN: { label: 'Kẹt design (>24h)', short: 'Kẹt design', tone: 'bg-amber-100 text-amber-900', dot: 'bg-amber-500' },
  NOT_EXPORTED: { label: 'Chưa export (>24h)', short: 'Chưa export', tone: 'bg-indigo-100 text-indigo-900', dot: 'bg-indigo-500' },
}

const DAY = 86400000
const DONE_PIPELINE = ['FULFILLED', 'CANCELLED', 'REFUNDED']

function isShopifyFulfilled(s: string | null | undefined): boolean {
  return (s ?? '').toUpperCase() === 'FULFILLED'
}

export type WarningInput = {
  placedAt: Date
  fulfillmentStatus?: string | null
  pipelineStatus?: string | null
}

export function computeWarnings(o: WarningInput, now: Date = new Date()): WarningType[] {
  const age = now.getTime() - o.placedAt.getTime()
  const ps = (o.pipelineStatus ?? '').toUpperCase()
  const out: WarningType[] = []

  if (age >= 7 * DAY && !isShopifyFulfilled(o.fulfillmentStatus) && !DONE_PIPELINE.includes(ps)) {
    out.push('LATE_FULFILLMENT')
  }
  if (age >= 1 * DAY && ps === 'PENDING_DESIGN') {
    out.push('STUCK_DESIGN')
  }
  if (age >= 1 * DAY && ps === 'READY_TO_PRODUCTION') {
    out.push('NOT_EXPORTED')
  }
  return out
}
