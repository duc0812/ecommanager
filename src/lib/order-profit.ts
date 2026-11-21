export type OrderLineForProfit = {
  qty: number
  resolvedSupplierId?: string | null
  resolvedBaseCost: number | null
  manualBaseCost: number | null
  resolvedShipFirst: number | null
  resolvedShipAdditional: number | null
  resolvedImportTax: number | null
}

export function effectiveBaseCost(line: Pick<OrderLineForProfit, 'manualBaseCost' | 'resolvedBaseCost'>): number | null {
  return line.manualBaseCost ?? line.resolvedBaseCost
}

export type OrderCostEstimate = {
  knownCogs: number
  estimatedCogs: number
  profit: number
  hasUnmapped: boolean
}

export function computeKnownOrderCogs(lines: OrderLineForProfit[]): number {
  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const baseCost = lines.reduce((s, l) => s + (effectiveBaseCost(l) ?? 0) * l.qty, 0)

  const dominantLine = lines.find(l => l.resolvedShipFirst !== null) ?? null
  const shipFirst = dominantLine?.resolvedShipFirst ?? 0
  const shipAdditional = dominantLine?.resolvedShipAdditional ?? 0
  const shipping = shipFirst + shipAdditional * Math.max(0, totalQty - 1)

  const importTax = lines.reduce((s, l) => s + (l.resolvedImportTax ?? 0) * l.qty, 0)
  return baseCost + shipping + importTax
}

// A line's cost is "unmapped" for COGS/profit purposes when its base cost is unknown: no cost at all, or a
// resolved cost of 0 (a supplier product mapped before it was priced, e.g. Reminiso tree toppers / duffles).
// A manually-entered base cost is authoritative (even 0), so a missing supplier does NOT trigger the
// estimate — supplier mapping is a separate status (see mappingSummary).
export function hasKnownBaseCost(line: Pick<OrderLineForProfit, 'manualBaseCost' | 'resolvedBaseCost'>): boolean {
  if (line.manualBaseCost != null) return true
  return line.resolvedBaseCost != null && line.resolvedBaseCost > 0
}

export function hasUnmappedProductCost(lines: OrderLineForProfit[]): boolean {
  return lines.some(l => !hasKnownBaseCost(l))
}

export function estimateOrderCostAndProfit(
  expectedPayout: number,
  lines: OrderLineForProfit[]
): OrderCostEstimate | null {
  if (lines.length === 0) return null

  const knownCogs = computeKnownOrderCogs(lines)
  const hasUnmapped = hasUnmappedProductCost(lines)
  const estimatedCogs = hasUnmapped
    ? knownCogs + (expectedPayout - knownCogs) / 2
    : knownCogs

  return {
    knownCogs,
    estimatedCogs,
    profit: expectedPayout - estimatedCogs,
    hasUnmapped,
  }
}

export function computeOrderProfitFromDb(
  expectedPayout: number,
  lines: OrderLineForProfit[]
): number | null {
  if (lines.length === 0) return null
  if (hasUnmappedProductCost(lines)) return null

  return expectedPayout - computeKnownOrderCogs(lines)
}
