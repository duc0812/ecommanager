import { describe, it, expect } from 'vitest'
import { FieldValidationError, normalizeField, resultStatus } from '@/lib/artwork-fields'

const BASE = { field: 'Name', layer: '@Name', sample: 'RACHEL', font: 'Script-Bold', sizePx: 96, color: '#FF0000', align: 'center', box: { x: 1, y: 2, w: 300, h: 80 }, anchor: 'center', tracking: 10 }

describe('normalizeField', () => {
  it('keeps scaleX, charColors, shadow.spread and layers', () => {
    const f = normalizeField({
      ...BASE, scaleX: 1.25, charColors: ['#FF0000', '#00ff00'], layers: ['@Name', '@Name shadow'],
      shadow: { dx: 2, dy: 3, blur: 4, color: '#000000', opacity: 0.5, spread: 6 },
    }, 0)
    expect(f).toMatchObject({
      color: '#ff0000', scaleX: 1.25, charColors: ['#ff0000', '#00ff00'], layers: ['@Name', '@Name shadow'],
      shadow: { dx: 2, dy: 3, blur: 4, color: '#000000', opacity: 0.5, spread: 6 }, fit: 'shrink',
    })
  })

  it('drops unknown keys and omits absent optional ones', () => {
    const f = normalizeField({ ...BASE, area: null, leading: null, stroke: null, shadow: null, psdInkW: 12, junk: { a: 1 } }, 0)
    expect(Object.keys(f).sort()).toEqual(['align', 'anchor', 'box', 'color', 'field', 'fit', 'font', 'layer', 'sample', 'sizePx', 'tracking'])
  })

  it('validates the new keys', () => {
    expect(() => normalizeField({ ...BASE, scaleX: 0 }, 0)).toThrow(FieldValidationError)
    expect(() => normalizeField({ ...BASE, scaleX: '1.2' }, 0)).toThrow(FieldValidationError)
    expect(() => normalizeField({ ...BASE, charColors: ['red'] }, 0)).toThrow(FieldValidationError)
    expect(() => normalizeField({ ...BASE, charColors: '#ff0000' }, 0)).toThrow(FieldValidationError)
    expect(() => normalizeField({ ...BASE, layers: [1] }, 0)).toThrow(FieldValidationError)
    expect(() => normalizeField({ ...BASE, shadow: { dx: 0, dy: 0, blur: 0, color: '#000000', opacity: 1, spread: 'x' } }, 0)).toThrow(FieldValidationError)
  })
})

describe('resultStatus', () => {
  const field = normalizeField(BASE, 0)
  it('READY needs a field, no warnings, no missing fonts and a passing score', () => {
    expect(resultStatus({ fields: [field], missingFonts: [], warnings: [], checkScore: 6 })).toBe('READY')
    expect(resultStatus({ fields: [], missingFonts: [], warnings: [], checkScore: 0 })).toBe('NEEDS_REVIEW')
    expect(resultStatus({ fields: [], missingFonts: [], warnings: ['no @ layers'], checkScore: null })).toBe('NEEDS_REVIEW')
    expect(resultStatus({ fields: [field], missingFonts: [], warnings: [], checkScore: 6.1 })).toBe('NEEDS_REVIEW')
    expect(resultStatus({ fields: [field], missingFonts: [], warnings: [], checkScore: null })).toBe('NEEDS_REVIEW')
    expect(resultStatus({ fields: [field], missingFonts: ['X'], warnings: [], checkScore: 1 })).toBe('NEEDS_FONTS')
  })
})
