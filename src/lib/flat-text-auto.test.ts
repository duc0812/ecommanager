import { describe, expect, it } from 'vitest'
import { flatTextCoversLine, parseFlatTextAuto, type FlatTextAutoLine, type FlatTextAutoProduct } from '@/lib/flat-text-auto'

const product: FlatTextAutoProduct = {
  storeId: 's', shopifyProductId: 'p', templateIds: ['wzip-m'], skus: ['TN1-Red', 'TN10-Red Wine'], nameField: 'Custom Name', fromOrder: 6000,
}
const named = [{ key: 'Custom Name:', value: 'Yes' }, { key: 'Custom Name', value: 'Deidrea' }]
const line = (over: Partial<FlatTextAutoLine> = {}): FlatTextAutoLine => ({
  storeId: 's', shopifyProductId: 'p', templateId: 'wzip-m', sku: 'TN1-Red', orderNumber: '#LIT6074', personalization: named, ...over,
})

describe('flatTextCoversLine', () => {
  it('takes a line with a name', () => {
    expect(flatTextCoversLine([product], line())).toBe(true)
  })

  it('takes a lone No, even with text left in the box', () => {
    expect(flatTextCoversLine([product], line({ personalization: [{ key: 'Custom Name:', value: 'No' }] }))).toBe(true)
    expect(flatTextCoversLine([product], line({ personalization: [{ key: 'Custom Name: Yes Or No?', value: 'No' }, { key: 'Custom Name', value: 'KANTORSKI' }] }))).toBe(true)
  })

  it('leaves Yes with no name to a person (LIT6061_1)', () => {
    expect(flatTextCoversLine([product], line({ personalization: [{ key: 'Custom Name:', value: 'Yes' }] }))).toBe(false)
  })

  it('leaves a line with no answer at all to a person', () => {
    expect(flatTextCoversLine([product], line({ personalization: [] }))).toBe(false)
  })

  it('needs the template the library was built for: a pin back to the old one ends it', () => {
    expect(flatTextCoversLine([product], line({ templateId: 'c979' }))).toBe(false)
  })

  it('needs a SKU the library has, in any case', () => {
    expect(flatTextCoversLine([product], line({ sku: 'tn10-red wine' }))).toBe(true)
    expect(flatTextCoversLine([product], line({ sku: 'TN1-Teal' }))).toBe(false)
    expect(flatTextCoversLine([product], line({ sku: null }))).toBe(false)
  })

  it('keeps orders before the cut on their old files', () => {
    expect(flatTextCoversLine([product], line({ orderNumber: '#LIT5742' }))).toBe(false)
    expect(flatTextCoversLine([product], line({ orderNumber: '#LIT6000' }))).toBe(true)
  })

  it('only answers for its own product', () => {
    expect(flatTextCoversLine([product], line({ shopifyProductId: 'other' }))).toBe(false)
    expect(flatTextCoversLine([product], line({ storeId: 'other' }))).toBe(false)
    expect(flatTextCoversLine([], line())).toBe(false)
  })
})

describe('parseFlatTextAuto', () => {
  it('reads nothing from a missing or broken setting', () => {
    expect(parseFlatTextAuto(null)).toEqual([])
    expect(parseFlatTextAuto('{oops')).toEqual([])
    expect(parseFlatTextAuto('{"a":1}')).toEqual([])
  })
})
