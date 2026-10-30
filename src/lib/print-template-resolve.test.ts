import { describe, expect, it } from 'vitest'
import { allSlotNames, chooseAreaSet, mapTemplate, parseAltSets, templateViewFor, type TemplateRow } from './print-template-resolve'

const area = (name: string, w = 100, h = 100, x = 0) => ({ name, x, y: 0, w, h })
const pieces = ['FRONT', 'BACK', 'HOOD', 'LEFT SLEEVE', 'RIGHT SLEEVE', 'CUFF']

function wzip(): TemplateRow {
  return mapTemplate({
    id: 't1', name: 'WZIP-S', widthPx: 12441, heightPx: 12568, dpi: 200, bleedIn: 0, safeIn: 0, mirror: false,
    areas: JSON.stringify([area('Print', 12441, 12568)]),
    altAreas: JSON.stringify([{ label: '12 mảnh', widthPx: 600, heightPx: 100, areas: pieces.map((p, i) => area(p, 100, 100, i * 100)) }]),
    guideImagePath: 'templates/t1/guide.png', templateUrl: null,
  })
}

const files = (...parts: string[]) => parts.map(p => ({ kind: 'PRINT', printArea: p, version: 1 }))

describe('alternative part sets (owner 10-30: a WZIP line delivers the sheet OR the 12 pieces, never both)', () => {
  it('parses the sets and lists every part name an upload may land in', () => {
    const t = wzip()
    expect(t.altSets).toHaveLength(1)
    expect(t.altSets[0].label).toBe('12 mảnh')
    expect(t.areaSet).toBeNull()
    expect(allSlotNames(t)).toEqual(['Print', ...pieces])
    expect(parseAltSets(null)).toEqual([])
    expect(parseAltSets('not json')).toEqual([])
    expect(parseAltSets(JSON.stringify([{ areas: [] }]))).toEqual([])
  })

  it('an empty line and a line with the sheet stay on the template areas', () => {
    const t = wzip()
    expect(chooseAreaSet(t, [])).toBe(-1)
    expect(chooseAreaSet(t, ['Print'])).toBe(-1)
    expect(templateViewFor(t, files('Print'))).toBe(t)
  })

  it('pieces uploaded move the line to the piece set: its areas, canvas and no sheet guide', () => {
    const t = wzip()
    expect(chooseAreaSet(t, ['front', 'Back'])).toBe(0)
    const view = templateViewFor(t, files('front', 'Back'))!
    expect(view.areaSet).toBe('12 mảnh')
    expect(view.areas.map(a => a.name)).toEqual(pieces)
    expect([view.widthPx, view.heightPx]).toEqual([600, 100])
    expect(view.guideImageUrl).toBeNull()
    expect(view.altSets).toBe(t.altSets)
  })

  it('a mixed line follows the set with more parts; a tie keeps the template areas', () => {
    const t = wzip()
    expect(chooseAreaSet(t, ['Print', 'FRONT'])).toBe(-1)
    expect(chooseAreaSet(t, ['Print', 'FRONT', 'BACK'])).toBe(0)
  })

  it('mockups and removed files do not count', () => {
    const t = wzip()
    const view = templateViewFor(t, [{ kind: 'MOCKUP', printArea: 'FRONT' }, { kind: 'PRINT', printArea: 'BACK', removedAt: new Date() }])
    expect(view).toBe(t)
  })

  it('a template without alternative sets is returned as is', () => {
    const plain = mapTemplate({ id: 'p', name: 'p', widthPx: 10, heightPx: 10, dpi: 150, bleedIn: 0, safeIn: 0, mirror: false, areas: '[]', guideImagePath: null, templateUrl: null })
    expect(plain.altSets).toEqual([])
    expect(templateViewFor(plain, files('FRONT'))).toBe(plain)
    expect(templateViewFor(null, [])).toBeNull()
  })
})
