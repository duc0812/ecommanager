import { describe, it, expect } from 'vitest'
import { resolveOrderDesign, parseDesignLibraryCsv, designKey, type DesignLineInput, type LibraryLookup } from './design-library'

const lookupFrom = (map: Record<string, { ready: boolean; designLink: string | null }>): LibraryLookup =>
  (sku, sup) => map[designKey(sku, sup)] ?? null

const baseLine = (over: Partial<DesignLineInput>): DesignLineInput => ({
  index: 0, sku: 'SKU1', isNonProduct: false, requiresDesign: true,
  resolvedSupplierId: 'supA', existingDesignLink: null, ...over,
})

describe('resolveOrderDesign', () => {
  it('order with no design-requiring lines is ready', () => {
    const r = resolveOrderDesign([baseLine({ requiresDesign: false })], lookupFrom({}))
    expect(r.orderDesignReady).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('ready when library has ready entry for resolved supplier, and returns its link', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
    )
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([{ index: 0, designLink: 'http://d/1' }])
  })

  it('missing when same SKU assigned to a different supplier without entry', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supB' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
    )
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supB' }])
  })

  it('existing design link (e.g. from Trello) counts as ready', () => {
    const r = resolveOrderDesign(
      [baseLine({ existingDesignLink: 'http://trello/link' })],
      lookupFrom({}),
    )
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([])
  })

  it('non-product lines are ignored', () => {
    const r = resolveOrderDesign(
      [baseLine({ isNonProduct: true, requiresDesign: true, resolvedSupplierId: null })],
      lookupFrom({}),
    )
    expect(r.orderDesignReady).toBe(true)
  })

  it('multi-line ready only when all design lines ready', () => {
    const r = resolveOrderDesign([
      baseLine({ index: 0, sku: 'A', resolvedSupplierId: 'supA' }),
      baseLine({ index: 1, sku: 'B', resolvedSupplierId: 'supA' }),
    ], lookupFrom({ [designKey('A', 'supA')]: { ready: true, designLink: 'x' } }))
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 1, sku: 'B', supplierId: 'supA' }])
  })

  it('unresolved supplier is missing (not ready)', () => {
    const r = resolveOrderDesign([baseLine({ resolvedSupplierId: null })], lookupFrom({}))
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing[0].supplierId).toBeNull()
  })
})

describe('parseDesignLibraryCsv', () => {
  it('parses valid rows and reports malformed lines', () => {
    const csv = 'sku,supplierCode,designLink\nSKU1,printful,http://d/1\nSKU2,,http://d/2\n,customcat,http://d/3'
    const { rows, errors } = parseDesignLibraryCsv(csv)
    expect(rows).toEqual([{ sku: 'SKU1', supplierCode: 'printful', designLink: 'http://d/1' }])
    expect(errors.length).toBe(2)
  })

  it('tolerates header column reordering', () => {
    const csv = 'designLink,sku,supplierCode\nhttp://d/1,SKU1,printful'
    const { rows } = parseDesignLibraryCsv(csv)
    expect(rows).toEqual([{ sku: 'SKU1', supplierCode: 'printful', designLink: 'http://d/1' }])
  })
})
