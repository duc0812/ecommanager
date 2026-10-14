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
