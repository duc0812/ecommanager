import type { WorkspaceLine } from '@/lib/design-studio'

export type HandoffMode = 'API' | 'CSV'

export type HandoffPush = { status: string; supplierOrderCode: string | null; externalOrderId: string }

export type HandoffState = {
  pending: boolean
  blocked: string | null
  mode: HandoffMode
  apiName: string | null
  apiNote: string | null
  handedOff: { at: string; mode: HandoffMode; byName: string | null } | null
  canUndo: boolean
  push: HandoffPush | null
}

export type HandoffLine = {
  line: WorkspaceLine; slots: string[]; taskKey: string; apiSku: string | null; driveFolderUrl: string | null
  /** Supplier this line was already sent to, null while it waits. */
  exportedTo: string | null
  /** Print parts whose newest file does not match the template size. */
  wrongSizeAreas: string[]
  /** What today's mapping would pick when it differs from the supplier the line was costed with (an order older than the mapping). */
  mappingNow: { supplierName: string; sku: string } | null
}

/** PGprints holds a new order this long (set on the PGprints account) before it goes to production; it can be cancelled until then. */
export const COOLING_OFF_HOURS = 2

export type SentStage = 'CSV_WAITING' | 'CSV_EXPORTED' | 'API_SENDING' | 'API_COOLING' | 'API_SENT' | 'TRACKING' | 'FULFILLED'

export type HandoffSent = {
  stage: SentStage; via: HandoffMode; at: string | null; byName: string | null
  code: string | null; remoteStatus: string | null; cancelUntil: string | null
  tracking: { number: string; carrier: string | null; url: string | null }[]
}

export const SENT_STAGE_LABELS: Record<SentStage, string> = {
  CSV_WAITING: 'Chờ xuất CSV',
  CSV_EXPORTED: 'Đã xuất CSV',
  API_SENDING: 'Đang gửi API — chưa rõ kết quả',
  API_COOLING: 'Đã gửi API — còn huỷ được',
  API_SENT: 'Đã gửi API — xưởng đang xử lý',
  TRACKING: 'Đã có tracking',
  FULFILLED: 'Đã giao (Shopify fulfilled)',
}

export type HandoffCard = {
  order: {
    id: string; orderNumber: string; placedAt: string; storeName: string; pipelineStatus: string
    customerName: string | null; country: string | null; countryCode: string | null; countryName: string | null; shipTo: string | null
  }
  suppliers: { id: string; name: string; code: string }[]
  lines: HandoffLine[]
  state: HandoffState
  /** "Đã xuất 1/2 xưởng — còn chờ: Jomall" while some suppliers already got their lines. */
  exportNote: string | null
  /** Set on the "Đã chuyển xưởng" list only. */
  sent: HandoffSent | null
}

export const HANDOFF_LABELS = {
  api: (name: string | null) => `Chuyển supplier qua API (${name ?? 'API'})`,
  csv: 'Lưu chờ xuất CSV',
  generic: 'Chuyển supplier',
  wait: 'Chờ người phụ trách xuất xưởng',
  savedCsv: 'Đã lưu chờ xuất CSV',
  undo: 'Hoàn tác',
} as const

export function pushChipLabel(push: HandoffPush): string {
  const code = push.supplierOrderCode ?? push.externalOrderId
  return push.status === 'CREATED' ? `Đã gửi PGprints ${code}` : `Đang gửi PGprints ${code} — chưa rõ kết quả`
}
