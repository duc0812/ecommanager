import { isNonProductLine, type LineForClassification } from '@/lib/order-lines'

export type ExportTrackedLine = LineForClassification & {
  id?: string
  linePosition?: number | null
  resolvedSupplierId: string | null
  exportedAt: Date | string | null
  exportedToSupplierId: string | null
}

export type ExportTrackedOrder<L extends ExportTrackedLine = ExportTrackedLine> = {
  pipelineStatus: string
  exportedAt: Date | string | null
  exportedToSupplierId: string | null
  lines: L[]
}

/**
 * Orders in these states go through the export (again): an order-level export recorded before per-line
 * tracking is stale for them, so it does not count as a line export.
 */
export const PRE_EXPORT_STATUSES = ['READY_TO_PRODUCTION', 'PENDING_DESIGN', 'DESIGN_REJECTED', 'PENDING_MAPPING']

/** Lines a supplier has to receive: production lines (no add-ons) with a resolved supplier. */
export function supplierLines<L extends ExportTrackedLine>(lines: L[]): L[] {
  return lines.filter(l => !isNonProductLine(l) && !!l.resolvedSupplierId)
}

export function hasLineTracking(order: ExportTrackedOrder): boolean {
  return order.lines.some(l => l.exportedAt != null)
}

/**
 * The supplier an order-level export (made before lines were tracked) implies for this line, or null.
 * Mirrored in scripts/backfill-line-export.mjs — keep the two in sync.
 */
export function legacyExportedTo(order: ExportTrackedOrder, line: ExportTrackedLine): string | null {
  if (!order.exportedAt || hasLineTracking(order) || PRE_EXPORT_STATUSES.includes(order.pipelineStatus)) return null
  if (isNonProductLine(line) || !line.resolvedSupplierId) return null
  if (line.resolvedSupplierId === order.exportedToSupplierId) return line.resolvedSupplierId
  // Lines of another supplier in an EXPORTED order: we cannot know whether they were sent by hand, so they count as sent.
  return order.pipelineStatus === 'EXPORTED' ? line.resolvedSupplierId : null
}

export function isLineExported(order: ExportTrackedOrder, line: ExportTrackedLine): boolean {
  return line.exportedAt != null || legacyExportedTo(order, line) != null
}

/** The supplier a line was sent to, or null when it was not sent. */
export function exportedSupplierOf(order: ExportTrackedOrder, line: ExportTrackedLine): string | null {
  if (line.exportedAt != null) return line.exportedToSupplierId ?? line.resolvedSupplierId
  return legacyExportedTo(order, line)
}

/** Lines the legacy order-level export marks, to be written before the order gets its first line-level mark. */
export function legacyMarks<L extends ExportTrackedLine>(order: ExportTrackedOrder<L>): Array<{ line: L; supplierId: string }> {
  const out: Array<{ line: L; supplierId: string }> = []
  for (const line of order.lines) {
    const supplierId = legacyExportedTo(order, line)
    if (supplierId) out.push({ line, supplierId })
  }
  return out
}

export function isFullyExported(order: ExportTrackedOrder): boolean {
  const lines = supplierLines(order.lines)
  return lines.length > 0 && lines.every(l => isLineExported(order, l))
}

export type SupplierExportGroup = {
  supplierId: string
  positions: number[]
  exported: number
  total: number
  done: boolean
  lastExportedAt: string | null
}

export type ExportProgress = {
  groups: SupplierExportGroup[]
  suppliersDone: number
  suppliersTotal: number
  linesExported: number
  linesTotal: number
  /** Some production lines were sent, others not yet. */
  partial: boolean
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null
  return typeof v === 'string' ? v : v.toISOString()
}

/** Per supplier: which lines it has and whether they were sent. A sent line counts for the supplier it went to. */
export function exportProgress(order: ExportTrackedOrder): ExportProgress {
  const groups = new Map<string, SupplierExportGroup>()
  let linesExported = 0
  const lines = supplierLines(order.lines)
  for (const line of lines) {
    const sentTo = exportedSupplierOf(order, line)
    const key = sentTo ?? (line.resolvedSupplierId as string)
    const g = groups.get(key) ?? { supplierId: key, positions: [], exported: 0, total: 0, done: false, lastExportedAt: null }
    g.total++
    if (line.linePosition != null) g.positions.push(line.linePosition)
    if (sentTo) {
      g.exported++
      linesExported++
      const at = iso(line.exportedAt) ?? iso(order.exportedAt)
      if (at && (!g.lastExportedAt || at > g.lastExportedAt)) g.lastExportedAt = at
    }
    groups.set(key, g)
  }
  const list = Array.from(groups.values()).map(g => ({ ...g, positions: g.positions.sort((a, b) => a - b), done: g.exported === g.total }))
  return {
    groups: list,
    suppliersDone: list.filter(g => g.done).length,
    suppliersTotal: list.length,
    linesExported,
    linesTotal: lines.length,
    partial: linesExported > 0 && linesExported < lines.length,
  }
}

/** Orders whose finished lines may go to their supplier. Design-rejected and unmapped orders wait whole. */
const SEND_STATUSES = ['READY_TO_PRODUCTION', 'PENDING_DESIGN']

type DesignGateLine = { shopifyLineId: string; designDriveLink: string | null; dropship?: boolean | null }
type LivePush = { supplierId: string; status: string; exportMarked: boolean; prevExportJson: string | null }
export type SendGateOrder<L> = {
  pipelineStatus: string; financialStatus: string | null; fulfillmentStatus: string | null; designReady: boolean; supplierHandoffAt: Date | null
  lines: L[]
  designTasks: { shopifyLineId: string; status: string; updatedAt: Date }[]
  /** The order's pushes with status SENDING or CREATED. */
  supplierPushes: LivePush[]
}

/** Why a line with a supplier does not go out now: design unfinished, saved for the CSV export, or already at the supplier by a push the app never marked. */
export type LineHold = 'DESIGN' | 'SAVED' | 'PUSHED'

/** The line's task is not DONE. A line with no task, or a cancelled one, goes by its design link or the order's approval. */
export function isDesignOpen(order: { designReady: boolean; designTasks: { shopifyLineId: string; status: string }[] }, line: DesignGateLine): boolean {
  if (line.dropship) return false
  const task = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
  if (task && task.status !== 'CANCELLED') return task.status !== 'DONE' || !line.designDriveLink
  return !line.designDriveLink && !order.designReady
}

export function isOrderClosed(order: { pipelineStatus: string; financialStatus: string | null; fulfillmentStatus: string | null }): boolean {
  return ['CANCELLED', 'REFUNDED', 'FULFILLED'].includes(order.pipelineStatus)
    || ['REFUNDED', 'VOIDED'].includes((order.financialStatus ?? '').toUpperCase())
    || (order.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED'
}

export function lineHold(order: Omit<SendGateOrder<unknown>, 'lines' | 'pipelineStatus' | 'financialStatus' | 'fulfillmentStatus'>, line: DesignGateLine & { resolvedSupplierId: string | null; costSnapshotAt?: Date | null }): LineHold | null {
  if (isDesignOpen(order, line)) return 'DESIGN'
  if (order.supplierPushes.some(p => p.supplierId === line.resolvedSupplierId && p.status === 'CREATED' && !p.exportMarked)) return 'PUSHED'
  if (!order.supplierHandoffAt) return null
  // A dropship line has no task: the save covered it when it was already mapped (the cost snapshot is stamped when a supplier is mapped).
  if (line.dropship) return line.costSnapshotAt && line.costSnapshotAt <= order.supplierHandoffAt ? 'SAVED' : null
  // A CSV save covers the lines approved by then; one approved later still has to be handed over.
  const task = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId && t.status === 'DONE')
  return !task || task.updatedAt <= order.supplierHandoffAt ? 'SAVED' : null
}

/** The lines that can go to their supplier now. Sibling lines do not matter. */
export function readyLines<L extends ExportTrackedLine & DesignGateLine>(order: SendGateOrder<L>): L[] {
  if (!SEND_STATUSES.includes(order.pipelineStatus) || isOrderClosed(order)) return []
  return supplierLines(order.lines).filter(l => !l.exportedAt && !lineHold(order, l))
}

function storedIds(push: { prevExportJson: string | null }, field: 'lineIds' | 'shopifyLineIds'): string[] | null {
  try {
    const ids = JSON.parse(push.prevExportJson ?? '{}')[field]
    return Array.isArray(ids) ? ids : null
  } catch {
    return null
  }
}

/**
 * The OrderLine ids of the lines a push carried, as it stored them. Null for a push made before sends went by line: it carried
 * every line of its supplier. The order sync makes the lines anew under new ids: read a push's lines with pushedShopifyLineIds.
 */
export function pushLineIds(push: { prevExportJson: string | null }): string[] | null {
  return storedIds(push, 'lineIds')
}

/** The Shopify line ids a push stored beside its OrderLine ids (since 2026-11-06); they survive the order sync. */
export function pushShopifyLineIds(push: { prevExportJson: string | null }): string[] | null {
  return storedIds(push, 'shopifyLineIds')
}

const ARTWORK_LINK = /\/api\/public\/artwork\/([0-9a-f]{64})\//g

/** The DesignArtwork tokens of the public print and mockup links a push sent: each file belongs to one line. */
export function pushFileTokens(requestJson: string | null | undefined): string[] {
  return Array.from(new Set(Array.from((requestJson ?? '').matchAll(ARTWORK_LINK), m => m[1])))
}

export type PushedLine = { id: string; shopifyLineId: string; exportedToSupplierId: string | null }

/** A push stored before Shopify line ids were recorded whose OrderLine ids the order sync has replaced. */
export function needsFileLines(push: { prevExportJson: string | null }, lines: Pick<PushedLine, 'id'>[]): boolean {
  const ids = pushLineIds(push)
  return !pushShopifyLineIds(push) && !!ids && ids.some(id => !lines.some(l => l.id === id))
}

/**
 * The Shopify lines a push carried, among the order's lines now. Null for a push made before sends went by line (every line
 * of its supplier). An older push whose OrderLine ids are gone carries the lines whose files it sent (`fileLines`, read from
 * its request by sentFileLines), else every line exported to its supplier.
 */
export function pushedShopifyLineIds(push: { supplierId: string; prevExportJson: string | null }, lines: PushedLine[], fileLines: string[] = []): string[] | null {
  const recorded = pushShopifyLineIds(push)
  if (recorded) return recorded
  const ids = pushLineIds(push)
  if (!ids) return null
  if (!needsFileLines(push, lines)) return ids.map(id => lines.find(l => l.id === id)!.shopifyLineId)
  if (fileLines.length > 0) return fileLines
  return lines.filter(l => l.exportedToSupplierId === push.supplierId).map(l => l.shopifyLineId)
}

type SendingLine = Pick<PushedLine, 'id' | 'shopifyLineId'> & { exportedToSupplierId?: string | null }

/**
 * Whether a live push holds one of these lines: by Shopify line id, or for an older push by OrderLine id or, once the order
 * sync replaced those, by the export mark it left on the line. A push from before sends went by line holds them all.
 */
function holdsAny(push: Pick<LivePush, 'supplierId' | 'prevExportJson'>, sending: SendingLine[]): boolean {
  const recorded = pushShopifyLineIds(push)
  if (recorded) return sending.some(l => recorded.includes(l.shopifyLineId))
  const ids = pushLineIds(push)
  return !ids || sending.some(l => ids.includes(l.id) || (!!l.exportedToSupplierId && l.exportedToSupplierId === push.supplierId))
}

/**
 * A live push blocks a new send until it landed and was marked, and it can only be sent beside when it does not hold the
 * lines being sent (as the build read them). Compared by Shopify line id, the answer outlives the order sync.
 */
export function canSendBeside(live: Pick<LivePush, 'supplierId' | 'status' | 'exportMarked' | 'prevExportJson'>[], sending: SendingLine[]): boolean {
  return live.every(p => p.status === 'CREATED' && p.exportMarked && !holdsAny(p, sending))
}

export function exportProgressLabel(p: Pick<ExportProgress, 'suppliersDone' | 'suppliersTotal'>): string {
  return `Đã xuất ${p.suppliersDone}/${p.suppliersTotal} xưởng`
}

/** "Đơn có 2 xưởng: Mangoshao (dòng 2) · Jomall (dòng 3)", or null for an order with one supplier. */
export function mixedSupplierNote(order: ExportTrackedOrder, nameOf: (supplierId: string) => string): string | null {
  const byResolved = new Map<string, number[]>()
  for (const line of supplierLines(order.lines)) {
    const key = line.resolvedSupplierId as string
    const list = byResolved.get(key) ?? []
    if (line.linePosition != null) list.push(line.linePosition)
    byResolved.set(key, list)
  }
  if (byResolved.size < 2) return null
  const parts = Array.from(byResolved.entries()).map(([id, positions]) => {
    const sorted = positions.sort((a, b) => a - b)
    return sorted.length > 0 ? `${nameOf(id)} (dòng ${sorted.join(', ')})` : nameOf(id)
  })
  return `Đơn có ${byResolved.size} xưởng: ${parts.join(' · ')}`
}
