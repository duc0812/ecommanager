import { describe, expect, it } from 'vitest'
import { UNMAPPED_TAB, type HandoffCard, type HandoffLine } from '@/lib/handoff-shared'
import { fmtUsd, hubTypeLabel, hubView } from '@/lib/handoff-hub'

function line(over: {
  key?: string; supplierId?: string | null; baseCost?: number | null; exportedTo?: string | null; wrongSizeAreas?: string[]; waiting?: HandoffLine['waiting']
  mappingNow?: { supplierName: string; sku: string } | null; previewUrl?: string | null; mockup?: boolean; productType?: string | null; supplierProduct?: string | null
} = {}): HandoffLine {
  const supplierId = over.supplierId === undefined ? 'jm' : over.supplierId
  return {
    send: { sku: null, size: '', color: '', customName: '' },
    taskKey: over.key ?? 'LIT1_1', baseCost: over.baseCost === undefined ? 10 : over.baseCost, productType: over.productType ?? null,
    exportedTo: over.exportedTo ?? null, wrongSizeAreas: over.wrongSizeAreas ?? [], mappingNow: over.mappingNow ?? null, waiting: over.waiting ?? null,
    slots: [], apiSku: null, driveFolderUrl: null,
    line: {
      supplier: supplierId ? { id: supplierId, name: supplierId, code: supplierId } : null,
      supplierProduct: over.supplierProduct ?? null,
      previewUrl: over.previewUrl === undefined ? 'https://cdn.example/p.png' : over.previewUrl,
      artworks: over.mockup ? [{ kind: 'MOCKUP' }] : [],
    },
  } as unknown as HandoffLine
}

const card = (lines: HandoffLine[]) => ({ lines } as unknown as HandoffCard)

describe('hubView', () => {
  it('counts only the unsent lines of the tab, with their own cost', () => {
    const v = hubView(card([
      line({ key: 'LIT1_1', baseCost: 12 }),
      line({ key: 'LIT1_2', supplierId: 'mz', baseCost: 8 }),
      line({ key: 'LIT1_3', baseCost: 7 }),
      line({ key: 'LIT1_4', baseCost: 100, exportedTo: 'Jomall' }),
    ]), 'jm')
    expect(v.lines.map(l => l.taskKey)).toEqual(['LIT1_1', 'LIT1_3'])
    expect(v.first?.taskKey).toBe('LIT1_1')
    expect(v.extra).toBe(1)
    expect(v.baseCost).toBe(19)
    expect(v.costMissing).toBe(false)
    expect(v.mixed).toBe(true)
  })

  it('says when a cost is missing, and keeps the known part', () => {
    const v = hubView(card([line({ baseCost: 5 }), line({ key: 'LIT1_2', baseCost: null })]), 'jm')
    expect(v.baseCost).toBe(5)
    expect(v.costMissing).toBe(true)
    expect(v.mixed).toBe(false)
  })

  it('finds a warning on a line the card does not show', () => {
    const v = hubView(card([line(), line({ key: 'LIT1_2', wrongSizeAreas: ['Front'] }), line({ key: 'LIT1_3', mappingNow: { supplierName: 'Mango', sku: 'X' } })]), 'jm')
    expect(v.warnings).toEqual([{ code: 'WRONG_SIZE', taskKey: 'LIT1_2' }, { code: 'MAPPING', taskKey: 'LIT1_3' }])
  })

  it('needs an uploaded mockup or the preview, not only the product photo', () => {
    expect(hubView(card([line({ previewUrl: null })]), 'jm').warnings).toEqual([{ code: 'NO_MOCKUP', taskKey: 'LIT1_1' }])
    expect(hubView(card([line({ previewUrl: null, mockup: true })]), 'jm').warnings).toEqual([])
  })

  it('puts a line with no supplier in the unmapped tab only', () => {
    const c = card([line({ supplierId: null }), line({ key: 'LIT1_2' })])
    expect(hubView(c, UNMAPPED_TAB).lines.map(l => l.taskKey)).toEqual(['LIT1_1'])
    expect(hubView(c, 'jm').lines.map(l => l.taskKey)).toEqual(['LIT1_2'])
  })

  it('counts a line in design nowhere, warns about nothing on it, and still names it', () => {
    const v = hubView(card([
      line({ key: 'LIT1_1', baseCost: 5, waiting: 'DESIGN', previewUrl: null, wrongSizeAreas: ['Front'] }),
      line({ key: 'LIT1_2', baseCost: 7 }),
      line({ key: 'LIT1_3', supplierId: 'mz', waiting: 'DESIGN' }),
      line({ key: 'LIT1_4', baseCost: 9, waiting: 'SAVED' }),
    ]), 'jm')
    expect(v.lines.map(l => l.taskKey)).toEqual(['LIT1_2'])
    expect(v.baseCost).toBe(7)
    expect(v.warnings).toEqual([])
    expect(v.inDesign.map(l => l.taskKey)).toEqual(['LIT1_1', 'LIT1_3'])
  })

  it('has no first line when the tab has nothing left on this order', () => {
    const v = hubView(card([line({ exportedTo: 'Jomall' })]), 'jm')
    expect(v.first).toBeNull()
    expect(v.extra).toBe(0)
  })
})

describe('labels', () => {
  it('shows the store type beside the supplier product', () => {
    expect(hubTypeLabel(line({ productType: 'Sherpa Hoodie', supplierProduct: 'WZIP · L' }))).toBe('Sherpa Hoodie → WZIP · L')
    expect(hubTypeLabel(line({ supplierProduct: 'WZIP · L' }))).toBe('WZIP · L')
    expect(hubTypeLabel(line())).toBe('')
  })

  it('formats dollars', () => {
    expect(fmtUsd(24.5)).toBe('$24.50')
  })
})
