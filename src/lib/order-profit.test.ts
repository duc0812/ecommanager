import { describe, expect, it } from 'vitest'
import { computeOrderProfitFromDb, estimateOrderCostAndProfit } from '@/lib/order-profit'

describe('computeOrderProfitFromDb', () => {
  it('returns null if any line has no resolvedBaseCost', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })

  it('returns null if a line has base cost but no supplier', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: 14, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })

  it('calculates profit for single-item order', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBe(25)
  })

  it('calculates profit for multi-item order', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 3, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 1 },
    ])
    expect(result).toBe(28)
  })

  it('uses first line with shipping for dominant supplier', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 10, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
      { qty: 2, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 15, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: 0 },
    ])
    expect(result).toBe(51)
  })

  it('returns profit=expectedPayout if no costs at all for a mapped zero-cost order', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 0, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBe(50)
  })
})

describe('estimateOrderCostAndProfit', () => {
  it('uses 50% payout as COGS when no product line is mapped', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])

    expect(result).toEqual({ knownCogs: 0, estimatedCogs: 50, profit: 50, hasUnmapped: true })
  })

  it('uses known COGS plus 50% of remaining payout for partial mapping', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 0, resolvedImportTax: 0 },
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])

    expect(result).toEqual({ knownCogs: 25, estimatedCogs: 62.5, profit: 37.5, hasUnmapped: true })
  })
})
