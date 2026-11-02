import { describe, it, expect } from 'vitest'
import { readableSheet } from '@/app/design-studio/components/model'
import type { TemplateRow } from '@/app/design-studio/components/types'

const row = (areas: TemplateRow['areas'], widthPx: number, heightPx: number) =>
  ({ id: 't', name: 'x', widthPx, heightPx, dpi: 200, bleedIn: 0, safeIn: 0, mirror: false, areas, guideImageUrl: 'guide.png', templateUrl: null, altSets: [] }) as unknown as TemplateRow

const inRow = (sizes: Array<[string, number, number]>) => {
  let x = 0
  return sizes.map(([name, w, h]) => { const a = { name, x, y: 0, w, h }; x += w; return a })
}
const PIECES: Array<[string, number, number]> = [
  ['FRONT', 5297, 5644], ['BACK', 4824, 5642], ['HOOD', 5030, 3336], ['LEFT SLEEVE', 3902, 5330], ['RIGHT SLEEVE', 3902, 5330], ['CUFF', 2067, 1121],
  ['FRONT HEM', 2513, 1078], ['BACK HEM', 4686, 1078], ['PLACKET', 669, 4898], ['UPPER POCKET', 1557, 2065], ['LOWER POCKET', 1595, 2112], ['POCKET WELT', 1632, 728],
]

describe('readableSheet', () => {
  it('packs a row of pieces into a screen-shaped sheet, keeping every size and name', () => {
    const view = readableSheet(row(inRow(PIECES), 37674, 5644))
    expect(view.areas.map(a => [a.name, a.w, a.h])).toEqual(PIECES)
    expect(view.widthPx / view.heightPx).toBeLessThan(5)
    expect(view.guideImageUrl).toBeNull()
  })
  it('no two pieces overlap and all stay inside the sheet', () => {
    const { areas, widthPx, heightPx } = readableSheet(row(inRow(PIECES), 37674, 5644))
    for (const a of areas) {
      expect(a.x + a.w).toBeLessThanOrEqual(widthPx)
      expect(a.y + a.h).toBeLessThanOrEqual(heightPx)
      for (const b of areas) {
        if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
    }
  })
  it('leaves a real sheet layout and a one or two part template alone', () => {
    const sheet = row([{ name: 'A', x: 0, y: 0, w: 10, h: 10 }, { name: 'B', x: 0, y: 20, w: 10, h: 10 }, { name: 'C', x: 20, y: 0, w: 10, h: 10 }], 30, 30)
    expect(readableSheet(sheet)).toBe(sheet)
    const two = row(inRow([['Front', 10, 10], ['Back', 10, 10]]), 20, 10)
    expect(readableSheet(two)).toBe(two)
  })
})
