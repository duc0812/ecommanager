import { describe, it, expect } from 'vitest'
import { computeOrderPL, type OrderInput, type SupplierInput } from '@/lib/pl-calculator'

describe('computeOrderPL', () => {
  it('computes profit for single-line order with one supplier', () => {
    const order: OrderInput = {
      grossAmount: 149.99,
      totalFees: 4.65,
      refundedAmount: 0,
      lines: [
        { sku: 'TSHIRT-RED-M', qty: 1, unitPrice: 149.99 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      'TSHIRT-RED-M': {
        supplierId: 'sup_printful',
        baseCost: 48.20,
        firstItemShipFee: 4.99,
        additionalItemShipFee: 2.99,
      },
    }
    const result = computeOrderPL(order, supplierMap)
    expect(result.expectedPayout).toBeCloseTo(145.34, 2)
    expect(result.totalBaseCost).toBeCloseTo(48.20, 2)
    expect(result.totalShipping).toBeCloseTo(4.99, 2)
    expect(result.profit).toBeCloseTo(92.15, 2)
    expect(result.defaultSupplierId).toBe('sup_printful')
    expect(result.hasUnmappedSku).toBe(false)
  })

  it('computes shipping correctly for 3-item order (first + 2 additional)', () => {
    const order: OrderInput = {
      grossAmount: 300,
      totalFees: 9,
      refundedAmount: 0,
      lines: [
        { sku: 'A', qty: 2, unitPrice: 100 },
        { sku: 'B', qty: 1, unitPrice: 100 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
      B: { supplierId: 'sup1', baseCost: 40, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.totalBaseCost).toBeCloseTo(2 * 30 + 1 * 40, 2)
    expect(r.totalShipping).toBeCloseTo(5 + 2 * 2, 2)
    expect(r.expectedPayout).toBeCloseTo(291, 2)
    expect(r.profit).toBeCloseTo(291 - 100 - 9, 2)
    expect(r.defaultSupplierId).toBe('sup1')
    expect(r.isMixedSupplier).toBe(false)
  })

  it('flags isMixedSupplier and null defaultSupplierId for 50/50 split', () => {
    const order: OrderInput = {
      grossAmount: 200,
      totalFees: 0,
      refundedAmount: 0,
      lines: [
        { sku: 'A', qty: 1, unitPrice: 100 },
        { sku: 'B', qty: 1, unitPrice: 100 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
      B: { supplierId: 'sup2', baseCost: 40, firstItemShipFee: 6, additionalItemShipFee: 3 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.isMixedSupplier).toBe(true)
    expect(r.defaultSupplierId).toBe(null)
  })

  it('flags hasUnmappedSku and excludes unmapped line from cost', () => {
    const order: OrderInput = {
      grossAmount: 100,
      totalFees: 3,
      refundedAmount: 0,
      lines: [
        { sku: 'KNOWN', qty: 1, unitPrice: 50 },
        { sku: 'UNKNOWN', qty: 1, unitPrice: 50 },
      ],
    }
    const supplierMap: Record<string, SupplierInput> = {
      KNOWN: { supplierId: 'sup1', baseCost: 20, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.hasUnmappedSku).toBe(true)
    expect(r.totalBaseCost).toBeCloseTo(20, 2)
    expect(r.perLineCost[1].resolvedBaseCost).toBe(null)
  })

  it('subtracts refundedAmount from expectedPayout', () => {
    const order: OrderInput = {
      grossAmount: 100,
      totalFees: 3,
      refundedAmount: 20,
      lines: [{ sku: 'A', qty: 1, unitPrice: 100 }],
    }
    const supplierMap: Record<string, SupplierInput> = {
      A: { supplierId: 'sup1', baseCost: 30, firstItemShipFee: 5, additionalItemShipFee: 2 },
    }
    const r = computeOrderPL(order, supplierMap)
    expect(r.expectedPayout).toBeCloseTo(77, 2)
    expect(r.profit).toBeCloseTo(77 - 30 - 5, 2)
  })
})
