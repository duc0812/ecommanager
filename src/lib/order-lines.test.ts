import { describe, it, expect } from 'vitest'
import { hasUnresolvedProductLine, isNonProductLine, lineKeysOf, productLinesOnly } from '@/lib/order-lines'

describe('isNonProductLine', () => {
  it('treats sku-less Tip line as non-product', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Tip' })).toBe(true)
  })

  it('treats sku-less Shipping protection line as non-product', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Shipping protection' })).toBe(true)
  })

  it('treats Package Protection insurance line as non-product even when it has a SKU and a physical product type', () => {
    expect(isNonProductLine({
      sku: 'SO-7980934',
      productTitle: 'Package Protection',
      shopifyProductType: 'Jewelry',
    })).toBe(true)
  })

  it('treats Custom Text digital line as non-product even when it has a SKU', () => {
    expect(isNonProductLine({ sku: 'LIT2570_1', productTitle: 'Custom Text' })).toBe(true)
  })

  it('matches Custom Text case-insensitively', () => {
    expect(isNonProductLine({ sku: 'ABC123_1', productTitle: 'CUSTOM TEXT' })).toBe(true)
    expect(isNonProductLine({ sku: 'ABC123_1', productTitle: '  custom text  ' })).toBe(true)
  })

  it('treats Custom Text Shopify product type as digital regardless of title', () => {
    expect(isNonProductLine({ sku: 'ABC1', productTitle: 'Personalized message', shopifyProductType: ' Custom Text ' })).toBe(true)
  })

  it('falls back to title when Shopify product type is missing', () => {
    expect(isNonProductLine({ productTitle: ' Custom Text ', shopifyProductType: null })).toBe(true)
  })

  it('treats Tip and Shipping protection as non-product even if the store gives them a SKU', () => {
    expect(isNonProductLine({ sku: 'TIP-1', productTitle: 'Tip' })).toBe(true)
    expect(isNonProductLine({ sku: 'SP-1', productTitle: 'Shipping protection', shopifyProductType: 'Kaching Cart Upsell Toggle' })).toBe(true)
  })

  it('keeps physical products with a real product type mappable', () => {
    expect(isNonProductLine({ sku: 'TEE1', productTitle: 'Premium Tee', shopifyProductType: 'Apparel' })).toBe(false)
  })

  it('keeps physical product lines with SKU as product lines', () => {
    expect(isNonProductLine({ sku: 'LIT2570', productTitle: 'Custom Name Necklace' })).toBe(false)
  })

  it('keeps sku-less lines with other titles as product lines', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Mystery Gift' })).toBe(false)
  })
})

describe('isNonProductLine: Reminiso add-ons (product type "Add-on")', () => {
  it('treats the product type Add-on as non-product, SKU and title aside', () => {
    expect(isNonProductLine({ sku: 'RM-ADDON-PROTECT', productTitle: 'Worry-Free Protection', shopifyProductType: 'Add-on' })).toBe(true)
    expect(isNonProductLine({ sku: 'RM-ADDON-NAME', productTitle: 'Custom Name Add-on', shopifyProductType: 'Add-on' })).toBe(true)
    expect(isNonProductLine({ sku: null, productTitle: 'Gift wrap', shopifyProductType: 'Add-on' })).toBe(true)
  })

  it('matches the type ignoring case and spaces', () => {
    expect(isNonProductLine({ sku: 'X', productTitle: 'Anything', shopifyProductType: '  ADD-ON ' })).toBe(true)
  })

  it('falls back to the two Reminiso titles when the product type is missing', () => {
    expect(isNonProductLine({ sku: 'RM-ADDON-PROTECT', productTitle: ' worry-free PROTECTION ', shopifyProductType: null })).toBe(true)
    expect(isNonProductLine({ sku: 'RM-ADDON-NAME', productTitle: 'Custom Name Add-on' })).toBe(true)
  })

  it('does not classify by SKU prefix or by a title that merely contains add-on', () => {
    expect(isNonProductLine({ sku: 'RM-ADDON-NAME', productTitle: 'Quilted Tote Bag', shopifyProductType: 'Tote Bag' })).toBe(false)
    expect(isNonProductLine({ sku: 'RM-X', productTitle: 'Custom Name Add-on Mug', shopifyProductType: 'Mug' })).toBe(false)
    expect(isNonProductLine({ sku: null, productTitle: 'Add-on Collection Tee', shopifyProductType: 'Apparel' })).toBe(false)
  })
})

describe('isNonProductLine: the personalisation app\'s hidden fee product', () => {
  it('treats product type PPLR_HIDDEN_PRODUCT as non-product, SKU and title aside, ignoring case and spaces', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Item Personalization', shopifyProductType: 'PPLR_HIDDEN_PRODUCT' })).toBe(true)
    expect(isNonProductLine({ sku: 'FEE-1', productTitle: 'Anything', shopifyProductType: ' pplr_hidden_product ' })).toBe(true)
  })

  it('does not catch a product by its title alone, or another product type', () => {
    expect(isNonProductLine({ sku: null, productTitle: 'Item Personalization', shopifyProductType: null })).toBe(false)
    expect(isNonProductLine({ sku: 'X', productTitle: 'Item Personalization', shopifyProductType: 'Baseball Jersey' })).toBe(false)
  })
})

describe('lineKeysOf with Reminiso add-ons', () => {
  it('numbers the product lines only, so a tote after two add-ons is _1', () => {
    const lines = [
      { shopifyLineId: 'a', linePosition: 1, sku: 'RM-ADDON-PROTECT', productTitle: 'Worry-Free Protection', shopifyProductType: 'Add-on' },
      { shopifyLineId: 'b', linePosition: 2, sku: 'RM-ADDON-NAME', productTitle: 'Custom Name Add-on', shopifyProductType: 'Add-on' },
      { shopifyLineId: 'c', linePosition: 3, sku: null, productTitle: 'Quilted Tote Bag', shopifyProductType: 'Tote Bag' },
    ]
    expect(Array.from(lineKeysOf('#REMI1147', lines))).toEqual([['c', 'REMI1147_1']])
  })
})

describe('hasUnresolvedProductLine', () => {
  const tote = { sku: null, productTitle: 'Quilted Tote Bag', shopifyProductType: 'Tote Bag', resolvedSupplierId: null }
  const topper = { sku: 'RM-TOP-TRACTOR-6IN', productTitle: 'Tree Topper', shopifyProductType: 'Tree Topper', resolvedSupplierId: 'sup' }
  const addOn = { sku: 'RM-ADDON-NAME', productTitle: 'Custom Name Add-on', shopifyProductType: 'Add-on', resolvedSupplierId: null }
  const tip = { sku: null, productTitle: 'Tip', shopifyProductType: null, resolvedSupplierId: null }

  it('counts a product line without a SKU, as the order sync does', () => {
    expect(hasUnresolvedProductLine([topper, tote])).toBe(true)
    expect(hasUnresolvedProductLine([{ ...tote, resolvedSupplierId: 'sup' }, topper])).toBe(false)
  })

  it('never counts an add-on, mapped or not', () => {
    expect(hasUnresolvedProductLine([addOn, tip, topper])).toBe(false)
    expect(hasUnresolvedProductLine([addOn, tip, tote])).toBe(true)
  })

  it('has nothing unresolved in an order without product lines', () => {
    expect(hasUnresolvedProductLine([addOn, tip])).toBe(false)
    expect(hasUnresolvedProductLine([])).toBe(false)
  })

  it('takes the caller\'s own test of "resolved"', () => {
    const costed = [{ ...topper, resolvedBaseCost: null as number | null }]
    expect(hasUnresolvedProductLine(costed)).toBe(false)
    expect(hasUnresolvedProductLine(costed, l => !!l.resolvedSupplierId && l.resolvedBaseCost != null)).toBe(true)
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
