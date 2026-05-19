export const PIPELINE_STATUSES = [
  'PENDING_DESIGN',
  'PENDING',
  'EXPORTED',
  'ON_HOLD',
  'SUPPLIER_PROCESSING',
  'IN_PRODUCTION',
  'FULFILLED',
  'DESIGN_REJECTED',
  'ERROR',
  'CANCELLED',
  'REFUNDED',
] as const

export type PipelineStatus = typeof PIPELINE_STATUSES[number]

export const STATUS_LABELS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'Pending Design',
  PENDING: 'Pending',
  EXPORTED: 'Exported',
  ON_HOLD: 'On Hold',
  SUPPLIER_PROCESSING: 'Supplier Processing',
  IN_PRODUCTION: 'In Production',
  FULFILLED: 'Fulfilled',
  DESIGN_REJECTED: 'Design Rejected',
  ERROR: 'Error',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

export const STATUS_COLORS: Record<PipelineStatus, string> = {
  PENDING_DESIGN: 'bg-amber-100 text-amber-900',
  PENDING: 'bg-blue-100 text-blue-900',
  EXPORTED: 'bg-indigo-100 text-indigo-900',
  ON_HOLD: 'bg-gray-200 text-gray-900',
  SUPPLIER_PROCESSING: 'bg-cyan-100 text-cyan-900',
  IN_PRODUCTION: 'bg-purple-100 text-purple-900',
  FULFILLED: 'bg-green-100 text-green-900',
  DESIGN_REJECTED: 'bg-orange-100 text-orange-900',
  ERROR: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-gray-300 text-gray-700',
  REFUNDED: 'bg-pink-100 text-pink-900',
}

/** Re-evaluated by sync — these initial statuses are overridden if conditions change */
const SYNC_RE_EVALUATED: PipelineStatus[] = ['PENDING_DESIGN', 'PENDING']

export function isValidPipelineStatus(v: string): v is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(v)
}

export type AutoDetectInput = {
  financialStatus: string
  hasUnmappedSku: boolean
  hasCustomDesignLine: boolean
  currentStatus?: PipelineStatus | null
}

export function autoDetectStatus(input: AutoDetectInput): PipelineStatus {
  const fs = (input.financialStatus || '').toUpperCase()

  // Highest priority: financial state from Shopify always wins for terminal-financial states
  if (fs.includes('REFUND')) return 'REFUNDED'
  if (fs === 'VOIDED' || fs === 'CANCELLED') return 'CANCELLED'

  // Compute what auto rules would say (initial state)
  const initial: PipelineStatus =
    input.hasUnmappedSku || input.hasCustomDesignLine ? 'PENDING_DESIGN' : 'PENDING'

  // If no existing status, return initial
  if (!input.currentStatus) return initial

  // If existing status is one of the auto-re-evaluated initial states → re-evaluate
  if (SYNC_RE_EVALUATED.includes(input.currentStatus)) return initial

  // Otherwise preserve manual status (user has moved past initial)
  return input.currentStatus
}
