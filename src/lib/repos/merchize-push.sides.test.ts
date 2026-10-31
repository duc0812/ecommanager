import { describe, expect, it } from 'vitest'
import { merchizeSideForPart, merchizeSideOf } from './merchize-push'

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
