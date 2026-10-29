import { describe, it, expect } from 'vitest'
import { machineQa } from '@/app/design-studio/components/ai-qa'

const tee = {
  id: 't1', name: 'Gildan 5000', widthPx: 4200, heightPx: 4800, dpi: 300, bleedIn: 0.125, safeIn: 0.25, mirror: false,
  areas: [{ name: 'Front', x: 0, y: 0, w: 4200, h: 4800 }, { name: 'Back', x: 0, y: 0, w: 4200, h: 4800 }], guideImageUrl: null, templateUrl: null,
}

let n = 0
const art = (printArea: string, over: Record<string, unknown> = {}) => ({
  id: `a${++n}`, kind: 'PRINT', printArea, version: 1, fileName: `${printArea}.png`, size: 1, mimeType: 'image/png', uploadedById: null,
  createdAt: `2026-10-29T10:0${n % 10}:00Z`, url: `/f/${printArea}`, widthPx: 4200, heightPx: 4800, storage: 'DRIVE', driveWebViewLink: null, source: 'MANUAL', previewUrl: null, ...over,
}) as any

const detail = (artworks: any[], over: { template?: any; slots?: string[] } = {}) => ({
  line: { artworks } as any,
  template: 'template' in over ? over.template : tee,
  slots: over.slots ?? ['Front', 'Back'],
})

const level = (r: ReturnType<typeof machineQa>, key: string) => r.items.find(i => i.key === key)?.level

describe('machineQa', () => {
  it('no print file yet: nothing to check', () => {
    expect(machineQa(detail([]))).toEqual({ status: 'none', items: [], newest: null })
  })

  it('every area filled at full size: all pass', () => {
    const r = machineQa(detail([art('Front'), art('Back')]))
    expect(r.status).toBe('pass')
    expect(r.items.map(i => i.key).sort()).toEqual(['areas', 'coverage', 'format', 'size'])
    expect(r.items.every(i => i.level === 'pass')).toBe(true)
  })

  it('a missing area is an error and sorts first', () => {
    const r = machineQa(detail([art('Front')]))
    expect(r.status).toBe('error')
    expect(r.items[0]).toMatchObject({ key: 'areas', level: 'error', detail: 'Thiếu Back' })
  })

  it('half-resolution file: an error on size, a warning on coverage, the detail names the DPI', () => {
    const r = machineQa(detail([art('Front', { widthPx: 2000, heightPx: 2400 }), art('Back')]))
    expect(level(r, 'size')).toBe('error')
    expect(level(r, 'coverage')).toBe('warn')
    expect(r.items.find(i => i.key === 'size')!.detail).toContain('~143 DPI (48%)')
  })

  it('a PSD is a format warning, not an error', () => {
    const r = machineQa(detail([art('Front', { mimeType: 'image/vnd.adobe.photoshop', fileName: 'front.psd' }), art('Back')]))
    expect(level(r, 'format')).toBe('warn')
    expect(r.status).toBe('warn')
  })

  it('LIT5105_1: files named apart from the template areas are not measured against the whole sheet', () => {
    const r = machineQa(detail([art('front', { widthPx: 3000, heightPx: 3000 }), art('back', { widthPx: 3000, heightPx: 3000 })]))
    expect(r.items.map(i => i.key).sort()).toEqual(['areas', 'format'])
    expect(r.items[0]).toMatchObject({ key: 'areas', level: 'error', detail: 'Thiếu Front, Back' })
  })

  it('without a template only format and file count are checked', () => {
    const r = machineQa(detail([art('front'), art('back')], { template: null, slots: [] }))
    expect(r.items.map(i => i.key).sort()).toEqual(['areas', 'format'])
    expect(r.items.find(i => i.key === 'areas')!.detail).toBe('2 file in')
    expect(r.status).toBe('pass')
  })
})
