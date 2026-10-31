import { describe, expect, it } from 'vitest'
import { merchizeSideForPart, merchizeSideOf, methodFor } from './merchize-push'

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
