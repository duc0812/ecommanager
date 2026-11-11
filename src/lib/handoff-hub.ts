import { UNMAPPED_TAB, type HandoffCard, type HandoffLine } from '@/lib/handoff-shared'

export type HubWarningCode = 'WRONG_SIZE' | 'MAPPING' | 'NO_MOCKUP'
export type HubWarning = { code: HubWarningCode; lineKey: string }

export const HUB_WARNING_LABELS: Record<HubWarningCode, string> = {
  WRONG_SIZE: 'sai khổ file',
  MAPPING: 'xưởng lệch mapping',
  NO_MOCKUP: 'thiếu mockup',
}

export type HubView = {
  /** The lines of this tab's supplier ready to go. */
  lines: HandoffLine[]
  sendableLines: HandoffLine[]
  /** Lines of this order, at any supplier, still in design: more to come, nothing that holds this card back. */
  inDesign: HandoffLine[]
  first: HandoffLine | null
  /** How many more lines the card stands for. */
  extra: number
  /** Base cost of those lines; shipping is not in it. */
  baseCost: number
  costMissing: boolean
  warnings: HubWarning[]
  /** Another supplier also has lines on this order. */
  mixed: boolean
}

/** An uploaded mockup or the customer's preview; the product's main photo alone may show another variant (owner 2026-11-04). */
function hasMockup(l: HandoffLine): boolean {
  return !!l.line.previewUrl || l.line.artworks.some(a => a.kind === 'MOCKUP')
}

export function hubView(card: HandoffCard, tabId: string): HubView {
  const supplierId = tabId === UNMAPPED_TAB ? null : tabId
  const lines = card.lines.filter(l => (l.line.supplier?.id ?? null) === supplierId && !l.exportedTo && !l.waiting)
  const warnings = lines.flatMap(l => {
    const out: HubWarning[] = []
    if (l.wrongSizeAreas.length > 0) out.push({ code: 'WRONG_SIZE', lineKey: l.lineKey })
    if (l.mappingNow) out.push({ code: 'MAPPING', lineKey: l.lineKey })
    if (l.line.supplier && !hasMockup(l)) out.push({ code: 'NO_MOCKUP', lineKey: l.lineKey })
    return out
  })
  return {
    lines,
    sendableLines: lines.filter(l => !warnings.some(w => w.lineKey === l.lineKey)),
    inDesign: card.lines.filter(l => l.waiting === 'DESIGN'),
    first: lines[0] ?? null,
    extra: Math.max(0, lines.length - 1),
    baseCost: lines.reduce((sum, l) => sum + (l.baseCost ?? 0), 0),
    costMissing: lines.some(l => l.baseCost == null),
    warnings,
    mixed: card.lines.some(l => (l.line.supplier?.id ?? null) !== supplierId),
  }
}

/** "Sherpa Hoodie → Fleece Zip · L": the store's type beside the supplier's product, so a wrong mapping shows. */
export function hubTypeLabel(l: HandoffLine): string {
  return [l.productType, l.line.supplierProduct].filter(Boolean).join(' → ')
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`
}
