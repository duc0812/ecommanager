import { isNonProductLine } from '@/lib/order-lines'
import { computeWarnings } from '@/lib/order-warnings'

// "Task Need Fix": data-state issues on active orders that a team must resolve.
// Detection is pure (computed from current order data); crons/sync handle the
// downstream resolution logic — a task simply reflects the current data state.

export type TaskDept = 'MAPPING' | 'DESIGN' | 'FULFILLMENT'
export type TaskType = 'MISSING_SKU' | 'UNMAPPED' | 'MISSING_BASE_COST' | 'MISSING_DESIGN' | 'LATE_FULFILLMENT' | 'TRACKING_STUCK'

export const TASK_TYPES: TaskType[] = ['MISSING_SKU', 'UNMAPPED', 'MISSING_BASE_COST', 'MISSING_DESIGN', 'LATE_FULFILLMENT', 'TRACKING_STUCK']

export const TASK_META: Record<TaskType, { dept: TaskDept; label: string }> = {
  MISSING_SKU: { dept: 'MAPPING', label: 'Thiếu SKU' },
  UNMAPPED: { dept: 'MAPPING', label: 'Chưa mapping' },
  MISSING_BASE_COST: { dept: 'MAPPING', label: 'Thiếu base cost' },
  MISSING_DESIGN: { dept: 'DESIGN', label: 'Thiếu design' },
  LATE_FULFILLMENT: { dept: 'FULFILLMENT', label: 'Trễ fulfillment' },
  TRACKING_STUCK: { dept: 'FULFILLMENT', label: 'Tracking chưa cập nhật' },
}

// Carriers whose numbers have been going dark: fulfilled, tracking handed over, but the
// parcel never shows a single checkpoint. Add a prefix here to watch another carrier.
export const STUCK_TRACKING_PREFIXES = ['JM']
// Grace period so a freshly handed-over tracking isn't flagged before it can activate.
// Anchored on placedAt (there is no fulfilledAt column): ~5 days production + a few days
// for the first scan.
export const STUCK_TRACKING_MIN_AGE_DAYS = 10

export type TaskLine = {
  sku: string | null
  productTitle: string
  shopifyProductType?: string | null
  resolvedSupplierId: string | null
  resolvedBaseCost: number | null
  manualBaseCost: number | null
}

export type TaskOrderInput = {
  orderType: string
  designReady: boolean
  lines: TaskLine[]
  // Time-based fulfillment tasks (optional — omitted by callers that only need
  // the line-level data checks). Reuses computeWarnings() for the SLA threshold.
  placedAt?: Date
  fulfillmentStatus?: string | null
  pipelineStatus?: string | null
}

export type OrderTask = { type: TaskType; dept: TaskDept; label: string; detail: string }

export type TaskShipment = { lineKey: string; trackingNumber: string | null; status: string }

export function isWatchedTracking(tracking: string | null | undefined): boolean {
  const v = (tracking ?? '').trim().toUpperCase()
  return v.length > 0 && STUCK_TRACKING_PREFIXES.some(p => v.startsWith(p))
}

// Fulfilled orders whose tracking never woke up. Kept separate from detectOrderTasks
// because that one only ever runs on ACTIVE orders — this is the one task that must be
// raised on orders already marked FULFILLED. Resolves itself as soon as ParcelPanel moves
// the shipment off PENDING.
export function detectStuckTrackingTask(o: {
  placedAt: Date
  pipelineStatus?: string | null
  shipments: TaskShipment[]
  now?: Date
}): OrderTask | null {
  const ps = (o.pipelineStatus ?? '').toUpperCase()
  if (ps === 'CANCELLED' || ps === 'REFUNDED') return null
  const ageDays = Math.floor(((o.now ?? new Date()).getTime() - o.placedAt.getTime()) / 86400000)
  if (ageDays < STUCK_TRACKING_MIN_AGE_DAYS) return null

  const stuck = o.shipments.filter(s => isWatchedTracking(s.trackingNumber) && (s.status ?? '').toUpperCase() === 'PENDING')
  if (stuck.length === 0) return null

  const detail = `${stuck.map(s => `${s.trackingNumber} (${s.lineKey})`).join(', ')} — chưa có cập nhật sau ${ageDays} ngày`
  return { type: 'TRACKING_STUCK', dept: TASK_META.TRACKING_STUCK.dept, label: TASK_META.TRACKING_STUCK.label, detail }
}

export function detectOrderTasks(o: TaskOrderInput): OrderTask[] {
  const product = o.lines.filter(l => !isNonProductLine({
    sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType,
  }))
  const tasks: OrderTask[] = []
  const add = (type: TaskType, detail: string) =>
    tasks.push({ type, dept: TASK_META[type].dept, label: TASK_META[type].label, detail })

  const missingSku = product.filter(l => !l.sku || !l.sku.trim())
  if (missingSku.length) add('MISSING_SKU', missingSku.map(l => l.productTitle).join(', '))

  const unmapped = product.filter(l => l.sku && l.sku.trim() && !l.resolvedSupplierId)
  if (unmapped.length) add('UNMAPPED', unmapped.map(l => l.sku).join(', '))

  const noCost = product.filter(l => l.resolvedSupplierId && l.resolvedBaseCost == null && l.manualBaseCost == null)
  if (noCost.length) add('MISSING_BASE_COST', noCost.map(l => l.sku ?? l.productTitle).join(', '))

  if (o.orderType === 'NON_CUSTOM' && !o.designReady) add('MISSING_DESIGN', 'Đơn non-custom chưa có design')

  if (o.placedAt) {
    const warnings = computeWarnings({
      placedAt: o.placedAt,
      fulfillmentStatus: o.fulfillmentStatus,
      pipelineStatus: o.pipelineStatus,
    })
    if (warnings.includes('LATE_FULFILLMENT')) {
      const days = Math.floor((Date.now() - o.placedAt.getTime()) / 86400000)
      add('LATE_FULFILLMENT', `Đơn đặt ${days} ngày trước, chưa fulfill`)
    }
  }

  return tasks
}
