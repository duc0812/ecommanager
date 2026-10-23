import { describe, it, expect } from 'vitest'
import { expectedSize, fileFormatLabel, printFileFit } from '@/lib/print-file-fit'

const stu = { widthPx: 3366, heightPx: 1819, areas: [{ name: 'Print', w: 3366, h: 1819 }] }
const twoSided = { widthPx: 4000, heightPx: 2000, areas: [{ name: 'Front', w: 1800, h: 1800 }, { name: 'Back', w: 0, h: 0 }] }

describe('printFileFit', () => {
  it('passes the area size or a full-canvas export, and names the size a wrong file should have', () => {
    expect(printFileFit(stu, 'Print', { widthPx: 3366, heightPx: 1819 })).toEqual({ state: 'ok', expected: { w: 3366, h: 1819 } })
    expect(printFileFit(stu, 'Print', { widthPx: 3270, heightPx: 1860 })).toEqual({ state: 'bad', expected: { w: 3366, h: 1819 } })
    expect(printFileFit(twoSided, 'Front', { widthPx: 4000, heightPx: 2000 }).state).toBe('ok')
    expect(expectedSize(twoSided, 'Back')).toEqual({ w: 4000, h: 2000 })
  })

  it('says when it cannot judge: no template, a part outside the template, or a file without pixel size', () => {
    expect(printFileFit(null, 'Print', { widthPx: 1, heightPx: 1 }).state).toBe('no-template')
    expect(printFileFit(stu, 'Lid', { widthPx: 1, heightPx: 1 }).state).toBe('extra')
    expect(printFileFit(stu, 'Print', { widthPx: null, heightPx: null })).toEqual({ state: 'unknown', expected: { w: 3366, h: 1819 } })
  })

  it('labels file formats the way designers name them', () => {
    expect(['image/png', 'image/jpeg', 'application/pdf', 'image/vnd.adobe.photoshop', 'image/webp'].map(fileFormatLabel)).toEqual(['PNG', 'JPG', 'PDF', 'PSD', 'WEBP'])
  })
})
