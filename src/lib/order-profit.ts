export type OrderLineForProfit = {
  qty: number
  resolvedBaseCost: number | null
  resolvedShipFirst: number | null
  resolvedShipAdditional: number | null
  resolvedImportTax: number | null
}

export function computeOrderProfitFromDb(
  expectedPayout: number,
  lines: OrderLineForProfit[]
): number | null {
  if (lines.length === 0) return null
  if (lines.some(l => l.resolvedBaseCost === null)) return null

  const totalQty = lines.reduce((s, l) => s + l.qty, 0)
  const totalBaseCost = lines.reduce((s, l) => s + l.resolvedBaseCost! * l.qty, 0)

  const dominantLine = lines.find(l => l.resolvedShipFirst !== null) ?? null
  const shipFirst = dominantLine?.resolvedShipFirst ?? 0
  const shipAdditional = dominantLine?.resolvedShipAdditional ?? 0
  const shipping = shipFirst + shipAdditional * Math.max(0, totalQty - 1)

  const importTax = lines.reduce((s, l) => s + (l.resolvedImportTax ?? 0) * l.qty, 0)

  return expectedPayout - totalBaseCost - shipping - importTax
}
