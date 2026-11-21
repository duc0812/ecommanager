import { describe, expect, it } from 'vitest'
import { computeOrderProfitFromDb, estimateOrderCostAndProfit } from '@/lib/order-profit'

describe('computeOrderProfitFromDb', () => {
  it('returns null if any line has no resolvedBaseCost', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })

  it('a known base cost without a supplier still yields a profit (supplier mapping is tracked separately)', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: 14, manualBaseCost: null, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBe(86)
  })

  it('calculates profit for single-item order', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, manualBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBe(25)
  })

  it('calculates profit for multi-item order', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 3, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, manualBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 1 },
    ])
    expect(result).toBe(28)
  })

  it('uses first line with shipping for dominant supplier', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 10, manualBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
      { qty: 2, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 15, manualBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: 0 },
    ])
    expect(result).toBe(51)
  })

  it('a mapped line whose supplier product is still priced at 0 has no known profit', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 0, manualBaseCost: null, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })
})

describe('estimateOrderCostAndProfit', () => {
  it('uses 50% payout as COGS when no product line is mapped', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])

    expect(result).toEqual({ knownCogs: 0, estimatedCogs: 50, profit: 50, hasUnmapped: true })
  })

  it('uses known COGS plus 50% of remaining payout for partial mapping', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'supplier-a', resolvedBaseCost: 20, manualBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 0, resolvedImportTax: 0 },
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])

    expect(result).toEqual({ knownCogs: 25, estimatedCogs: 62.5, profit: 37.5, hasUnmapped: true })
  })
})

describe('manualBaseCost override', () => {
  it('uses manualBaseCost over resolvedBaseCost in cogs', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedSupplierId: 'sup1', resolvedBaseCost: 40, manualBaseCost: 25, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeCloseTo(100 - 25 - 5, 2)
  })

  it('line with supplier and only a manual cost is not unmapped', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'sup1', resolvedBaseCost: null, manualBaseCost: 30, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])
    expect(result?.hasUnmapped).toBe(false)
    expect(result?.estimatedCogs).toBeCloseTo(30, 2)
  })

  it('manual cost without supplier mapping is authoritative for COGS (not unmapped)', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: 30, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])
    expect(result?.hasUnmapped).toBe(false)
    expect(result?.profit).toBe(70)
  })
})

describe('zero resolved base cost gets the 50% estimate (Reminiso tree topper / duffle lines)', () => {
  it('a supplier-mapped line priced 0 is estimated at 50% of payout, like an unmapped LZ line', () => {
    const zeroCost = estimateOrderCostAndProfit(80, [
      { qty: 1, resolvedSupplierId: 'go3d', resolvedBaseCost: 0, manualBaseCost: null, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    const unmapped = estimateOrderCostAndProfit(80, [
      { qty: 1, resolvedSupplierId: null, resolvedBaseCost: null, manualBaseCost: null, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: null },
    ])
    expect(zeroCost).toEqual({ knownCogs: 0, estimatedCogs: 40, profit: 40, hasUnmapped: true })
    expect(zeroCost).toEqual(unmapped)
  })

  it('a zero-cost line next to a priced line estimates half of what the priced line leaves', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'mango', resolvedBaseCost: 20, manualBaseCost: null, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
      { qty: 1, resolvedSupplierId: 'go3d', resolvedBaseCost: 0, manualBaseCost: null, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toEqual({ knownCogs: 20, estimatedCogs: 60, profit: 40, hasUnmapped: true })
  })

  it('a manual base cost of 0 stays authoritative', () => {
    const result = estimateOrderCostAndProfit(100, [
      { qty: 1, resolvedSupplierId: 'go3d', resolvedBaseCost: 0, manualBaseCost: 0, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toEqual({ knownCogs: 0, estimatedCogs: 0, profit: 100, hasUnmapped: false })
  })
})
