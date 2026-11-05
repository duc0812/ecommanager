import type { WorkspaceLine } from '@/lib/design-studio'

export type HandoffMode = 'API' | 'CSV' | 'SHEET'
export type SupplierApiKind = 'pgprints' | 'merchize' | 'bondre' | 'printway'

export const SUPPLIER_API_NAMES: Record<SupplierApiKind, string> = { pgprints: 'PGprints', merchize: 'Merchize', bondre: 'Bondre', printway: 'Printway' }

export type HandoffPush = { status: string; supplierOrderCode: string | null; externalOrderId: string }

export type HandoffState = {
  pending: boolean
  blocked: string | null
  mode: HandoffMode
  apiName: string | null
  /** Which supplier's push window the order opens; an unsent Merchize line opens Merchize's, then another API supplier's. */
  apiKind?: SupplierApiKind
  /** A Merchize line has not been sent; it can only go by API. */
  merchizeOpen?: boolean
  /** The API supplier with an unsent line and a saved key; those lines go by API, not CSV. */
  apiOpenKind?: SupplierApiKind | null
  /** The order has lines of an API supplier, and another supplier's unsent lines that still wait for a CSV export. */
  csvRemainder?: boolean
  /** A line of a supplier on the sheet channel has not been sent; it can only go through the hub. */
  sheetOpen?: boolean
  /** CSV is locked for every supplier: a line with no API or sheet has nowhere to go until it opens. */
  csvLocked?: boolean
  apiNote: string | null
  handedOff: { at: string; mode: HandoffMode; byName: string | null } | null
  canUndo: boolean
  push: HandoffPush | null
}

export type HandoffLine = {
  line: WorkspaceLine; slots: string[]; taskKey: string; apiSku: string | null; driveFolderUrl: string | null
  /** The line's base cost for its whole quantity, null while no cost is known. Shipping is not in it. */
  baseCost: number | null
  /** The Shopify product type, shown beside the supplier's product so a wrong mapping is seen at a glance. */
  productType: string | null
  /** What a send writes to the supplier's sheet for this line, shown on the card to be checked first. */
  send: { sku: string | null; size: string; color: string; customName: string }
  /** Supplier this line was already sent to, null while it waits. */
  exportedTo: string | null
  /** Print parts whose newest file does not match the template size. */
  wrongSizeAreas: string[]
  /** What today's mapping would pick when it differs from the supplier the line was costed with (an order older than the mapping). */
  mappingNow: { supplierName: string; sku: string } | null
}

/** PGprints holds a new order this long (set on the PGprints account) before it goes to production; it can be cancelled until then. */
export const COOLING_OFF_HOURS = 2

export type SentStage = 'CSV_WAITING' | 'CSV_EXPORTED' | 'SHEET_SENT' | 'API_SENDING' | 'API_COOLING' | 'API_SENT' | 'TRACKING' | 'FULFILLED'

export type HandoffSent = {
  stage: SentStage; via: HandoffMode; at: string | null; byName: string | null
  code: string | null; remoteStatus: string | null; cancelUntil: string | null
  tracking: { number: string; carrier: string | null; url: string | null }[]
}

export const SENT_STAGE_LABELS: Record<SentStage, string> = {
  CSV_WAITING: 'Chờ xuất CSV',
  CSV_EXPORTED: 'Đã xuất CSV',
  SHEET_SENT: 'Đã ghi vào sheet xưởng',
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

/** The "Duyệt sản xuất" tab of orders with a line no supplier is mapped to. */
export const UNMAPPED_TAB = 'none'

export type HubChannel = 'API' | 'CSV' | 'SHEET'

/**
 * One supplier's tab: the orders with an unsent line of that supplier, and what those lines cost.
 * `designCount` is the orders still in design, what is coming next.
 */
export type HubTab = { id: string; name: string; channel: HubChannel | null; orderCount: number; baseCostTotal: number; designCount: number }

export const HANDOFF_LABELS = {
  produceApi: 'Sản xuất - API',
  produceSheet: 'Sản xuất - Sheet',
  api: (name: string | null) => `Chuyển supplier qua API (${name ?? 'API'})`,
  csv: 'Lưu chờ xuất CSV',
  generic: 'Chuyển supplier',
  wait: 'Chờ người phụ trách xuất xưởng',
  savedCsv: 'Đã lưu chờ xuất CSV',
  undo: 'Hoàn tác',
} as const

export function pushChipLabel(push: HandoffPush, kind: SupplierApiKind = 'pgprints'): string {
  const code = push.supplierOrderCode ?? push.externalOrderId
  const name = SUPPLIER_API_NAMES[kind]
  return push.status === 'CREATED' ? `Đã gửi ${name} ${code}` : `Đang gửi ${name} ${code} — chưa rõ kết quả`
}
