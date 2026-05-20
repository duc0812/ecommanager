export const PIPELINE_STATUSES = [
  'PENDING_DESIGN',
  'PENDING_MAPPING',
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
  PENDING_MAPPING: 'Pending Mapping',
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
  PENDING_MAPPING: 'bg-rose-100 text-rose-900',
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

const SYNC_RE_EVALUATED: PipelineStatus[] = ['PENDING_DESIGN', 'PENDING_MAPPING', 'PENDING']

export function isValidPipelineStatus(v: string): v is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(v)
}

export type AutoDetectInput = {
  financialStatus: string
  hasUnmappedSku: boolean
  hasPendingMapping: boolean
  hasCustomDesignLine: boolean
  currentStatus?: PipelineStatus | null
}

export function autoDetectStatus(input: AutoDetectInput): PipelineStatus {
  const fs = (input.financialStatus || '').toUpperCase()

  if (fs.includes('REFUND')) return 'REFUNDED'
  if (fs === 'VOIDED' || fs === 'CANCELLED') return 'CANCELLED'

  const initial: PipelineStatus =
    input.hasPendingMapping ? 'PENDING_MAPPING' :
    input.hasUnmappedSku || input.hasCustomDesignLine ? 'PENDING_DESIGN' :
    'PENDING'

  if (!input.currentStatus) return initial
  if (SYNC_RE_EVALUATED.includes(input.currentStatus)) return initial
  return input.currentStatus
}
