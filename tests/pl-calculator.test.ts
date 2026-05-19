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
})
