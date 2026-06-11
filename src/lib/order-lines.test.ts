import { describe, it, expect } from 'vitest'
import { isNonProductLine, productLinesOnly } from '@/lib/order-lines'

describe('isNonProductLine', () => {
  it('treats sku-less Tip line as non-product', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Tip' })).toBe(true)
  })

  it('treats sku-less Shipping protection line as non-product', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Shipping protection' })).toBe(true)
  })

  it('treats Custom Text digital line as non-product even when it has a SKU', () => {
    expect(isNonProductLine({ sku: 'LIT2570_1', productTitle: 'Custom Text' })).toBe(true)
  })

  it('matches Custom Text case-insensitively', () => {
    expect(isNonProductLine({ sku: 'ABC123_1', productTitle: 'CUSTOM TEXT' })).toBe(true)
    expect(isNonProductLine({ sku: 'ABC123_1', productTitle: '  custom text  ' })).toBe(true)
  })

  it('keeps physical product lines with SKU as product lines', () => {
    expect(isNonProductLine({ sku: 'LIT2570', productTitle: 'Custom Name Necklace' })).toBe(false)
  })

  it('keeps sku-less lines with other titles as product lines', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Mystery Gift' })).toBe(false)
  })
})

describe('productLinesOnly', () => {
  it('filters out digital and non-product lines', () => {
    const lines = [
      { sku: 'LIT2570', productTitle: 'Custom Name Necklace' },
      { sku: 'LIT2570_1', productTitle: 'Custom Text' },
      { sku: null, productTitle: 'Tip' },
    ]
    expect(productLinesOnly(lines)).toEqual([{ sku: 'LIT2570', productTitle: 'Custom Name Necklace' }])
  })
})
