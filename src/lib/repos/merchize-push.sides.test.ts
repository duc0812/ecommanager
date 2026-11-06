import { describe, expect, it } from 'vitest'
import { merchizeSideForPart, merchizeSideOf, methodFor, variantMethods } from './merchize-push'

describe('methodFor', () => {
  it('keeps the store default when the blank offers it or the catalog is unknown', () => {
    expect(methodFor({ methods: ['DTF', 'DTG'] }, 'DTF')).toBe('DTF')
    expect(methodFor(undefined, 'DTF')).toBe('DTF')
  })

  it('switches to the only method the blank offers', () => {
    expect(methodFor({ methods: ['DTG'] }, 'DTF')).toBe('DTG')
  })

  it('sends no method for a product that lists none (AOP, acrylic)', () => {
    expect(methodFor({ methods: [] }, 'DTF')).toBeNull()
  })
})

describe('variantMethods', () => {
  const tiers = (dtf: number | null, dtg: number | null) => [
    { name: 'dtf_tier1', price: dtf }, { name: 'dtf_tier2', price: null }, { name: 'dtg_tier1', price: dtg }, { name: 'dtg_tier2', price: null },
  ]

  it('keeps only the methods the variant is priced for', () => {
    // Bella 3005US Black 3XL: the product lists DTF and DTG, the size has a DTG price only.
    expect(variantMethods(['DTF', 'DTG'], tiers(null, 13.99))).toEqual(['DTG'])
    expect(methodFor({ methods: variantMethods(['DTF', 'DTG'], tiers(null, 13.99)) }, 'DTF')).toBe('DTG')
  })

  it('keeps the store default where the variant is priced for it', () => {
    expect(variantMethods(['DTF', 'DTG'], tiers(7, 9.19))).toEqual(['DTF', 'DTG'])
    expect(methodFor({ methods: variantMethods(['DTF', 'DTG'], tiers(7, 9.19)) }, 'DTF')).toBe('DTF')
  })

  it("leaves the product's list when the tiers name no method or price none", () => {
    expect(variantMethods(['DTF', 'DTG'], [{ name: 'tier1', price: 12 }])).toEqual(['DTF', 'DTG'])
    expect(variantMethods(['DTF', 'DTG'], tiers(null, null))).toEqual(['DTF', 'DTG'])
    expect(variantMethods([], tiers(null, 20))).toEqual([])
  })
})

describe('merchizeSideOf', () => {
  it('reads the side from the part name', () => {
    expect(merchizeSideOf('Front')).toBe('design_front')
    expect(merchizeSideOf('back')).toBe('design_back')
    expect(merchizeSideOf('LEFT SLEEVE')).toBe('design_sleeve')
    expect(merchizeSideOf('Outer Hood')).toBe('design_hood')
    expect(merchizeSideOf('Artwork')).toBe('design_front')
  })

  it('knows no side for a sheet part name', () => {
    expect(merchizeSideOf('Print')).toBeNull()
  })
})

describe('merchizeSideForPart', () => {
  it('treats the only part of a line as the front whatever its name', () => {
    expect(merchizeSideForPart('Print', ['Print'])).toBe('design_front')
    expect(merchizeSideForPart('Sheet', ['Sheet'])).toBe('design_front')
  })

  it('still refuses an unnamed side when the line has several parts', () => {
    expect(merchizeSideForPart('Print', ['Print', 'back'])).toBeNull()
    expect(merchizeSideForPart('back', ['Print', 'back'])).toBe('design_back')
  })
})
