import { describe, expect, it } from 'vitest'
import { resolveSupplierForOrderLine, type SupplierProductCandidate } from '@/lib/auto-mapping'

const base = {
  firstItemShipFee: 5,
  additionalItemShipFee: 2,
  supplierPreferenceRank: 0,
  supplierName: 'Supplier',
  supplierCode: 'supplier',
}

describe('resolveSupplierForOrderLine', () => {
  it('uses product tags to distinguish same visible variant between 2D and 3D suppliers without relying on design SKU', () => {
    const candidates: SupplierProductCandidate[] = [
      {
        ...base,
        sku: 'POMO-GIFT-TEE',
        supplierId: 'sup_2d',
        supplierName: '2D Supplier',
        supplierCode: '2d',
        baseCost: 8,
        productName: 'POMo Gift Shirt',
        productType: 'Tshirt',
        printingMethod: '2D DTG',
      },
      {
        ...base,
        sku: 'POMO-GIFT-TEE',
        supplierId: 'sup_3d',
        supplierName: '3D Supplier',
        supplierCode: '3d',
        baseCost: 14,
        productName: 'POMo Gift Shirt',
        productType: 'Tshirt',
        printingMethod: '3D AOP',
      },
    ]

    const result = resolveSupplierForOrderLine({
      sku: 'DESIGN-POMO-001',
      title: 'POMo Gift Shirt',
      variantTitle: 'Tshirt / XL',
      productType: 'Tshirt',
      productTags: ['3D', 'gift'],
    }, candidates)

    expect(result.supplier?.supplierId).toBe('sup_3d')
    expect(result.supplier?.baseCost).toBe(14)
    expect(result.reasons).toContain('design:3D')
  })

  it('falls back to preference rank when metadata cannot separate candidates', () => {
    const candidates: SupplierProductCandidate[] = [
      { ...base, sku: 'SUP-A', supplierId: 'low', baseCost: 10, supplierPreferenceRank: 1 },
      { ...base, sku: 'SUP-B', supplierId: 'high', baseCost: 12, supplierPreferenceRank: 5 },
    ]

    const result = resolveSupplierForOrderLine({
      sku: 'DESIGN-A',
      title: 'Plain Shirt',
      variantTitle: 'Tshirt',
      productTags: [],
    }, candidates)

    expect(result.supplier?.supplierId).toBe('high')
  })
})
