export type OrderLineInput = {
  sku: string | null
  qty: number
  unitPrice: number
}

export type OrderInput = {
  grossAmount: number
  totalFees: number
  refundedAmount: number
  lines: OrderLineInput[]
}

export type SupplierInput = {
  supplierId: string
  baseCost: number
  firstItemShipFee: number
  additionalItemShipFee: number
}

export type OrderPLResult = {
  expectedPayout: number
  totalBaseCost: number
  totalShipping: number
  profit: number
  marginPct: number
  defaultSupplierId: string | null
  hasUnmappedSku: boolean
  isMixedSupplier: boolean
  perLineCost: Array<{ sku: string | null; resolvedSupplierId: string | null; resolvedBaseCost: number | null }>
}

export function computeOrderPL(
  order: OrderInput,
  supplierMap: Record<string, SupplierInput>
): OrderPLResult {
  const expectedPayout = order.grossAmount - order.totalFees - order.refundedAmount

  let totalBaseCost = 0
  let totalQty = 0
  const supplierQty: Record<string, number> = {}
  let hasUnmappedSku = false
  const perLineCost: OrderPLResult['perLineCost'] = []

  for (const line of order.lines) {
    totalQty += line.qty
    const sup = line.sku ? supplierMap[line.sku] : undefined
    if (!sup) {
      hasUnmappedSku = true
      perLineCost.push({ sku: line.sku, resolvedSupplierId: null, resolvedBaseCost: null })
      continue
    }
    totalBaseCost += sup.baseCost * line.qty
    supplierQty[sup.supplierId] = (supplierQty[sup.supplierId] || 0) + line.qty
    perLineCost.push({ sku: line.sku, resolvedSupplierId: sup.supplierId, resolvedBaseCost: sup.baseCost })
  }

  const supplierIds = Object.keys(supplierQty)
  const defaultSupplierIdRaw = supplierIds.length === 0
    ? null
    : supplierIds.reduce((a, b) => supplierQty[a] >= supplierQty[b] ? a : b)
  const isMixedSupplier = supplierIds.length > 1 && defaultSupplierIdRaw !== null &&
    supplierIds.filter(id => supplierQty[id] === supplierQty[defaultSupplierIdRaw]).length > 1

  let totalShipping = 0
  if (defaultSupplierIdRaw && !isMixedSupplier) {
    const sup = Object.values(supplierMap).find(s => s.supplierId === defaultSupplierIdRaw)!
    totalShipping = sup.firstItemShipFee + sup.additionalItemShipFee * Math.max(0, totalQty - 1)
  }

  const profit = expectedPayout - totalBaseCost - totalShipping
  const marginPct = expectedPayout === 0 ? 0 : (profit / expectedPayout) * 100

  return {
    expectedPayout,
    totalBaseCost,
    totalShipping,
    profit,
    marginPct,
    defaultSupplierId: isMixedSupplier ? null : defaultSupplierIdRaw,
    hasUnmappedSku,
    isMixedSupplier,
    perLineCost,
  }
}
