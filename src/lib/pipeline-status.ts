export const PIPELINE_STATUSES = [
  'PENDING_DESIGN',
  'PENDING_MAPPING',
  'WARNING',
  'READY_TO_PRODUCTION',
  'EXPORTED',
  'ON_HOLD',
  'FULFILLED',
  'DESIGN_REJECTED',
  'ERROR',
  'CANCELLED',
  'REFUNDED',
] as const

export type PipelineStatus = typeof PIPELINE_STATUSES[number]

export const STATUS_LABELS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'Pending Design',
  PENDING_MAPPING: 'Pending Mapping',
  WARNING: 'Warning',
  READY_TO_PRODUCTION: 'Ready to Production',
  EXPORTED: 'Exported',
  ON_HOLD: 'On Hold',
  FULFILLED: 'Fulfilled',
  DESIGN_REJECTED: 'Design Rejected',
  ERROR: 'Error',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

export const STATUS_COLORS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'bg-amber-100 text-amber-900',
  PENDING_MAPPING: 'bg-rose-100 text-rose-900',
  WARNING: 'bg-red-100 text-red-900',
  READY_TO_PRODUCTION: 'bg-emerald-100 text-emerald-900',
  EXPORTED: 'bg-indigo-100 text-indigo-900',
  ON_HOLD: 'bg-gray-200 text-gray-900',
  FULFILLED: 'bg-green-100 text-green-900',
  DESIGN_REJECTED: 'bg-orange-100 text-orange-900',
  ERROR: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-300 text-gray-700',
  REFUNDED: 'bg-pink-100 text-pink-900',
}

export const WARNING_AFTER_DAYS = 8
export const TERMINAL_PIPELINE_STATUSES: PipelineStatus[] = ['CANCELLED', 'REFUNDED']

const SYNC_RE_EVALUATED: PipelineStatus[] = ['PENDING_DESIGN', 'PENDING_MAPPING', 'WARNING', 'READY_TO_PRODUCTION']

export function isValidPipelineStatus(v: string): v is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(v)
}

export function warningCutoffDate(now = new Date()): Date {
  return new Date(now.getTime() - WARNING_AFTER_DAYS * 24 * 60 * 60 * 1000)
}

export function isUnfulfilledStatus(status: string | null | undefined): boolean {
  return (status ?? '').toUpperCase() !== 'FULFILLED'
}

export function isWarningOrder(input: { placedAt: Date; fulfillmentStatus?: string | null; pipelineStatus?: string | null; now?: Date }) {
  if (TERMINAL_PIPELINE_STATUSES.includes(input.pipelineStatus as PipelineStatus)) return false
  return input.placedAt <= warningCutoffDate(input.now) && isUnfulfilledStatus(input.fulfillmentStatus)
}

export type AutoDetectInput = {
  financialStatus: string
  fulfillmentStatus?: string | null
  hasUnmappedSku: boolean
  hasPendingMapping: boolean
  hasCustomDesignLine: boolean
  hasDesignReady?: boolean
  currentStatus?: PipelineStatus | null
}

export function autoDetectStatus(input: AutoDetectInput): PipelineStatus {
  const fs = (input.financialStatus || '').toUpperCase()

  if (fs.includes('REFUND')) return 'REFUNDED'
  if (fs === 'VOIDED' || fs === 'CANCELLED') return 'CANCELLED'

  const fulfillment = (input.fulfillmentStatus || '').toLowerCase()
  if (fulfillment === 'fulfilled') return 'FULFILLED'

  const initial: PipelineStatus =
    input.hasPendingMapping || input.hasUnmappedSku ? 'PENDING_MAPPING' :
    input.hasCustomDesignLine && !input.hasDesignReady ? 'PENDING_DESIGN' :
    'READY_TO_PRODUCTION'

  if (!input.currentStatus) return initial
  if (SYNC_RE_EVALUATED.includes(input.currentStatus)) return initial
  return input.currentStatus
}
