import { describe, it, expect } from 'vitest'
import { resolveOrderDesign, resolveOrderDesignByParent, parseDesignLibraryCsv, designKey, type DesignLineInput, type LibraryLookup } from './design-library'

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

  it('ready-but-null-link entry is treated as missing', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: null } }),
    )
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supA' }])
  })

  it('allowReuse:false ignores the library (always missing without own link)', () => {
    const r = resolveOrderDesign(
      [baseLine({ sku: 'SKU1', resolvedSupplierId: 'supA' })],
      lookupFrom({ [designKey('SKU1', 'supA')]: { ready: true, designLink: 'http://d/1' } }),
      { allowReuse: false },
    )
    expect(r.orderDesignReady).toBe(false)
    expect(r.lineLinks).toEqual([])
    expect(r.missing).toEqual([{ index: 0, sku: 'SKU1', supplierId: 'supA' }])
  })

  it('allowReuse:false still honors own existing design link', () => {
    const r = resolveOrderDesign(
      [baseLine({ existingDesignLink: 'http://trello/link' })],
      lookupFrom({}),
      { allowReuse: false },
    )
    expect(r.orderDesignReady).toBe(true)
  })
})

const pLine = (over: Partial<any> = {}) => ({
  index: 0, sku: 'DN15041511-TS', isNonProduct: false, requiresDesign: true,
  resolvedSupplierId: 'supA', existingDesignLink: null, customized: false, ...over,
})
const parents = [{ parentCode: 'DN15041511', supplierId: 'supA', designLink: 'L', designType: 'NON_CUSTOM' }]

describe('resolveOrderDesignByParent', () => {
  it('reuses by parent code for a non-customized line', () => {
    const r = resolveOrderDesignByParent([pLine()], parents)
    expect(r.orderDesignReady).toBe(true)
    expect(r.lineLinks).toEqual([{ index: 0, designLink: 'L' }])
  })
  it('customized line is missing even if parent has a design', () => {
    const r = resolveOrderDesignByParent([pLine({ customized: true })], parents)
    expect(r.orderDesignReady).toBe(false)
    expect(r.missing).toEqual([{ index: 0, sku: 'DN15041511-TS', supplierId: 'supA' }])
  })
  it('no parent match => missing', () => {
    const r = resolveOrderDesignByParent([pLine({ sku: 'ZZZ-1' })], parents)
    expect(r.orderDesignReady).toBe(false)
  })
  it('own existing link wins', () => {
    const r = resolveOrderDesignByParent([pLine({ existingDesignLink: 'own', customized: true })], parents)
    expect(r.orderDesignReady).toBe(true)
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
