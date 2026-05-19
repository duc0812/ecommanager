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
