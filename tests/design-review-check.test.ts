import { describe, it, expect } from 'vitest'
import { machineQa } from '@/app/design-studio/components/ai-qa'
import { reviewVerdict } from '@/app/design-studio/components/review-check'

const tee = {
  id: 't1', name: 'Gildan 5000', widthPx: 4200, heightPx: 4800, dpi: 300, bleedIn: 0.125, safeIn: 0.25, mirror: false,
  areas: [{ name: 'Front', x: 0, y: 0, w: 4200, h: 4800 }, { name: 'Back', x: 0, y: 0, w: 4200, h: 4800 }], guideImageUrl: null, templateUrl: null,
}

let n = 0
const art = (printArea: string, over: Record<string, unknown> = {}) => ({
  id: `a${++n}`, kind: 'PRINT', printArea, version: 1, fileName: `${printArea}.png`, size: 1, mimeType: 'image/png', uploadedById: null,
  createdAt: `2026-10-29T10:0${n % 10}:00Z`, url: `/f/${printArea}`, widthPx: 4200, heightPx: 4800, storage: 'DRIVE', driveWebViewLink: null, driveFileId: null, source: 'MANUAL', previewUrl: null, ...over,
}) as any

function detail(artworks: any[], over: Record<string, unknown> = {}) {
  return {
    task: { status: 'REVIEW', rejectReasons: [] } as any,
    line: {
      artworks, supplier: { id: 's1', name: 'Merchize' }, supplierSku: 'T5000', customized: true, attributesLoaded: true, customallPending: false,
      personalization: [{ key: 'Name', value: 'Emily' }], sourcePrintFiles: [],
    } as any,
    template: tee, slots: ['Front', 'Back'], library: null, profile: null,
    me: { isLeader: true, canApprove: true } as any,
    ...over,
  }
}

const verdict = (d: ReturnType<typeof detail>) => reviewVerdict(d as any, machineQa(d as any))

describe('reviewVerdict', () => {
  it('everything in order: no issues, one summary line', () => {
    const v = verdict(detail([art('Front'), art('Back'), art('Front', { kind: 'MOCKUP' })]))
    expect(v.status).toBe('ok')
    expect(v.issues).toEqual([])
    expect(v.summary).toBe('Gildan 5000 · 4200×4800 · 300 DPI · 2/2 vùng in · PNG/JPG · 1 mockup')
  })

  it('passing checks are never listed; a missing mockup is a warning, not a blocker', () => {
    const v = verdict(detail([art('Front'), art('Back')]))
    expect(v.status).toBe('warn')
    expect(v.issues.map(i => i.key)).toEqual(['mockup'])
  })

  it('errors sort before warnings and name the file', () => {
    const v = verdict(detail([art('Front', { widthPx: 2000, heightPx: 2400 })]))
    expect(v.status).toBe('error')
    expect(v.issues.map(i => i.key)).toEqual(['qa-size', 'qa-areas', 'qa-coverage', 'mockup'])
    expect(v.issues[0].text).toContain('Khổ & DPI')
    expect(v.issues[1].text).toBe('Đủ file mọi vùng: Thiếu Back')
  })

  it('no print file at all is the only error', () => {
    const v = verdict(detail([]))
    expect(v.issues.map(i => i.key)).toEqual(['qa-none'])
    expect(v.status).toBe('error')
  })

  it('customer data the customizer never sent is an error; a missing artwork library entry is not', () => {
    const d = detail([art('Front'), art('Back'), art('Front', { kind: 'MOCKUP' })], {
      line: { artworks: [art('Front'), art('Back'), art('Front', { kind: 'MOCKUP' })], supplier: { id: 's1', name: 'Merchize' }, customized: true, attributesLoaded: false, personalization: [], sourcePrintFiles: [] },
      library: { status: 'NONE', key: 'p1', layers: [], entryId: null },
    })
    const v = verdict(d)
    expect(v.issues.map(i => i.key)).toEqual(['check-customer'])
    expect(v.issues[0].text).toContain('nạp lại từ Shopify')
  })

  it('no template but a supplier: a warning to check the size by hand', () => {
    const v = verdict(detail([art('Front'), art('Front', { kind: 'MOCKUP' })], { template: null, slots: [] }))
    expect(v.issues.map(i => i.key)).toEqual(['template'])
    expect(v.summary).toBe('1 file in · PNG/JPG · 1 mockup')
  })
})
