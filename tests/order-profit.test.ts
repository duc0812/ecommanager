import { describe, it, expect } from 'vitest'
import { computeOrderProfitFromDb } from '@/lib/order-profit'

describe('computeOrderProfitFromDb', () => {
  it('returns null if any line has no resolvedBaseCost', () => {
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedBaseCost: null, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBeNull()
  })

  it('calculates profit for single-item order', () => {
    // expectedPayout=50, baseCost=20*1=20, shipping=5+0=5, import=0 → profit=25
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
    ])
    expect(result).toBe(25)
  })

  it('calculates profit for multi-item order', () => {
    // expectedPayout=100, baseCost=20*3=60, shipping=5+2*(3-1)=9, import=1*3=3 → profit=28
    const result = computeOrderProfitFromDb(100, [
      { qty: 3, resolvedBaseCost: 20, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 1 },
    ])
    expect(result).toBe(28)
  })

  it('uses first line with shipping for dominant supplier', () => {
    // 2 lines, first has shipping, second does not
    // qty=1+2=3, baseCost=10+15*2=40, shipping from line0: 5+2*(3-1)=9, import=0 → profit=100-40-9=51
    const result = computeOrderProfitFromDb(100, [
      { qty: 1, resolvedBaseCost: 10, resolvedShipFirst: 5, resolvedShipAdditional: 2, resolvedImportTax: 0 },
      { qty: 2, resolvedBaseCost: 15, resolvedShipFirst: null, resolvedShipAdditional: null, resolvedImportTax: 0 },
    ])
    expect(result).toBe(51)
  })

  it('returns profit=expectedPayout if no costs at all (zero cost order)', () => {
    const result = computeOrderProfitFromDb(50, [
      { qty: 1, resolvedBaseCost: 0, resolvedShipFirst: 0, resolvedShipAdditional: 0, resolvedImportTax: 0 },
    ])
    expect(result).toBe(50)
  })
})
