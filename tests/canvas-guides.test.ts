import { describe, expect, it } from 'vitest'
import { ALL_GUIDES, areaAt, areaViewBox, clientToTemplate, parseGuides } from '@/app/design-studio/components/canvas-guides'

const front = { name: 'Front', x: 0, y: 0, w: 1000, h: 1200 }
const back = { name: 'Back', x: 1100, y: 0, w: 1000, h: 1200 }
const pocket = { name: 'Pocket', x: 100, y: 100, w: 200, h: 200 }

describe('areaAt', () => {
  it('finds the area under a template point', () => {
    expect(areaAt([front, back], 500, 600)?.name).toBe('Front')
    expect(areaAt([front, back], 1500, 600)?.name).toBe('Back')
  })
  it('returns null between areas and outside the sheet', () => {
    expect(areaAt([front, back], 1050, 600)).toBeNull()
    expect(areaAt([front, back], -10, 600)).toBeNull()
  })
  it('prefers the smallest area when areas overlap', () => {
    expect(areaAt([front, pocket], 150, 150)?.name).toBe('Pocket')
  })
  it('a single-area template takes the whole sheet', () => {
    expect(areaAt([front], 5000, -40)?.name).toBe('Front')
    expect(areaAt([], 1, 1)).toBeNull()
  })
})

describe('clientToTemplate', () => {
  it('maps a drop into the correct panel after focusing and zooming the view', () => {
    const focused = areaViewBox([back], 0.5)!
    const rect = { left: -200, top: 10, width: focused.w * 3, height: focused.h * 3 }
    const p = clientToTemplate(rect, focused, 0.5, rect.left + rect.width / 2, rect.top + rect.height / 2)
    expect(p.x).toBeCloseTo(1600)
    expect(p.y).toBeCloseTo(600)
    expect(areaAt([front, back], p.x, p.y)?.name).toBe('Back')
  })
  it('fits both selected pieces without changing their positions', () => {
    expect(areaViewBox([front, back], 1)).toEqual({ x: -10, y: -10, w: 2120, h: 1220 })
    expect(areaViewBox([], 1)).toBeNull()
  })
  const viewBox = { x: -30, y: -22, w: 1260, h: 1250 }
  it('maps a client point through the viewBox and sheet scale', () => {
    const rect = { left: 100, top: 50, width: 630, height: 625 }
    const p = clientToTemplate(rect, viewBox, 0.5, 100 + 15, 50 + 11)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
    const q = clientToTemplate(rect, viewBox, 0.5, 100 + 315, 50 + 311)
    expect(q.x).toBeCloseTo(1200)
    expect(q.y).toBeCloseTo(1200)
  })
  it('accounts for letterboxing when the box is wider than the viewBox', () => {
    const rect = { left: 0, top: 0, width: 1260 * 2, height: 1250 }
    const p = clientToTemplate(rect, viewBox, 1, 630 + 30, 22)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
  })
})

describe('parseGuides', () => {
  it('defaults to all guides on', () => {
    expect(parseGuides(null)).toEqual(ALL_GUIDES)
    expect(parseGuides('not json')).toEqual(ALL_GUIDES)
    expect(parseGuides('[]')).toEqual(ALL_GUIDES)
  })
  it('keeps stored booleans and fills the rest', () => {
    expect(parseGuides(JSON.stringify({ areas: false, bleed: false, guide: 'x' }))).toEqual({ areas: false, safe: true, bleed: false, guide: true })
  })
})
