import { describe, it, expect } from 'vitest'
import { isPrintCutTemplate, printCutCheck, PRINT_CUT_SIZING, topperPrintCutTemplate } from '@/lib/print-cut'
import { machineQa } from '@/app/design-studio/components/ai-qa'
import { expectedSize, printFileFit } from '@/lib/print-file-fit'
import { sharpnessRatio } from '@/app/design-studio/components/model'

const template = {
  id: 'pair', name: 'Tree Topper', widthPx: 2000, heightPx: 1000, dpi: 300, bleedIn: 0, safeIn: 0, mirror: false,
  areas: ['Print', 'Cut'].map((name, i) => ({ name, x: i * 1000, y: 0, w: 1000, h: 1000, sizing: PRINT_CUT_SIZING })),
  guideImageUrl: null, templateUrl: null, altSets: [], areaSet: null,
}
const file = (printArea: string, widthPx: number | null = 731, heightPx: number | null = 1254, version = 1): any => ({
  id: `${printArea}${version}`, kind: 'PRINT', printArea, widthPx, heightPx, version, mimeType: 'image/png',
  fileName: `${printArea}.png`, createdAt: `2026-11-11T00:0${version}:00Z`, url: '/test.png',
})
const qa = (artworks: any[]) => machineQa({ line: { artworks } as any, slots: ['Print', 'Cut'], template })

describe('print/cut sizing', () => {
  it('recognizes Topper types without guessing from product titles or affecting other acrylic products', () => {
    for (const type of ['Tree Topper', ' TOPPER ', 'Acrylic Tree Topper']) {
      expect(isPrintCutTemplate(topperPrintCutTemplate(type))).toBe(true)
    }
    for (const type of [null, 'LED Light Tree', 'Acrylic Magnet', 'Acrylic Light Box', 'T-Shirt']) {
      expect(topperPrintCutTemplate(type)).toBeNull()
    }
  })
  it('uses the Gỗ 3D VN preset only for its supplier, while keeping an unmapped task editable', () => {
    expect(topperPrintCutTemplate('Tree Topper', '3')?.name).toContain('Gỗ 3D VN')
    expect(topperPrintCutTemplate('Tree Topper')?.id).toBe('preset:go-3d-topper-print-cut')
    for (const supplier of ['BONDRE', 'PRINTWAY', '', null]) {
      expect(topperPrintCutTemplate('Tree Topper', supplier)).toBeNull()
    }
  })
  it('accepts arbitrary matching dimensions without template size, DPI or bleed requirements', () => {
    const files = [file('Print'), file('Cut')]
    expect(printCutCheck(template, files)?.ok).toBe(true)
    expect(qa(files).status).toBe('pass')
    expect(qa(files).items.map(i => i.key)).toEqual(['print-cut', 'format', 'areas'])
    expect(printFileFit(template, 'Print', files[0])).toEqual({ state: 'paired', expected: null })
    expect(expectedSize(template, 'Cut')).toBeNull()
    expect(sharpnessRatio(template, files[0])).toBeNull()
  })

  it('requires both files and does not count mockups or removed files', () => {
    expect(printCutCheck(template, [file('Print'), { ...file('Cut'), kind: 'MOCKUP' }])?.message).toContain('Thiếu file: Cut')
    expect(printCutCheck(template, [file('Print'), { ...file('Cut'), removedAt: new Date() }])?.ok).toBe(false)
    expect(qa([file('Print')]).status).toBe('error')
  })

  it('rejects mismatches in either direction and swapped orientation', () => {
    for (const [w, h] of [[732, 1254], [731, 1255], [1254, 731]]) {
      expect(qa([file('Print'), file('Cut', w, h)]).items.find(i => i.key === 'print-cut')?.level).toBe('error')
    }
  })

  it('never claims that unmeasured files match', () => {
    expect(printCutCheck(template, [file('Print', null, null), file('Cut', null, null)])?.ok).toBe(false)
    expect(printCutCheck(template, [file('Print'), file('Cut', -1, 1254)])?.ok).toBe(false)
  })

  it('uses the newest current version and label aliases', () => {
    const files = [file('Print'), file('Cut'), file(' cut ', 400, 600, 2)]
    expect(printCutCheck(template, files)?.ok).toBe(false)
    expect(printCutCheck(template, [...files, file('Print', 400, 600, 3)])?.ok).toBe(true)
  })

  it('keeps fixed templates and extra files on their existing rules', () => {
    const fixed = { ...template, areas: template.areas.map(({ sizing, ...a }) => a) }
    expect(isPrintCutTemplate(fixed)).toBe(false)
    expect(printCutCheck(fixed, [])).toBeNull()
    expect(printFileFit(fixed, 'Print', file('Print')).state).toBe('bad')
    expect(printFileFit(template, 'Extra', file('Extra')).state).toBe('extra')
  })
})
