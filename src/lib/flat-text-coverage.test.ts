import { describe, expect, it } from 'vitest'
import type { LocalEntry } from '@/lib/artwork-library-state'
import { autoFromLocalLibrary, designOf, type FlatTextSpec, type LocalLibraryLine } from '@/lib/flat-text-coverage'

const spec = (over: Partial<FlatTextSpec> = {}): FlatTextSpec => ({ design: 'TN1', supplierSku: 'WZIP-M', skuIs: 'TN1-Red', minOrder: 6000, fields: ['Custom Name'], ...over })
const flat = (specs: FlatTextSpec[], over: Partial<LocalEntry> = {}): LocalEntry => ({ id: 'flat-text:x', storeId: 's', shopifyProductId: 'p', printTemplateId: 't', optionKey: '', status: 'READY', specs, ...over })
const psd = (over: Partial<LocalEntry> = {}): LocalEntry => ({ id: 'e', storeId: 's', shopifyProductId: 'p', printTemplateId: 't', optionKey: '', status: 'READY', fields: ['Custom Name'], ...over })
const named = [{ key: 'Custom Name:', value: 'Yes' }, { key: 'Custom Name', value: 'Deidrea' }]
const line = (over: Partial<LocalLibraryLine> = {}): LocalLibraryLine => ({
  sku: 'TN1-Red', supplierSku: 'WZIP-M', variantTitle: 'Red / M', orderNumber: '#LIT6074', templateId: 't',
  variantOptions: '{"Color":"Red","Size":"M"}', artworkSplits: null, personalization: named, ...over,
})

describe('a flat-text spec in the local library', () => {
  it('takes a many-area line with a name', () => {
    expect(autoFromLocalLibrary([flat([spec()])], line())).toBe(true)
  })

  it('takes a lone No, even with text left in the box', () => {
    expect(autoFromLocalLibrary([flat([spec()])], line({ personalization: [{ key: 'Custom Name:', value: 'No' }] }))).toBe(true)
    expect(autoFromLocalLibrary([flat([spec()])], line({ personalization: [{ key: 'Custom Name: Yes Or No?', value: 'No' }, { key: 'Custom Name', value: 'KANTORSKI' }] }))).toBe(true)
  })

  it('leaves Yes with no name to a person (LIT6061_1)', () => {
    expect(autoFromLocalLibrary([flat([spec()])], line({ personalization: [{ key: 'Custom Name:', value: 'Yes' }] }))).toBe(false)
    expect(autoFromLocalLibrary([flat([spec()])], line({ personalization: [] }))).toBe(false)
  })

  it('only serves the colour and size the spec was made for', () => {
    expect(autoFromLocalLibrary([flat([spec()])], line({ sku: 'TN1-Teal' }))).toBe(false)
    expect(autoFromLocalLibrary([flat([spec()])], line({ supplierSku: 'WZIP-L' }))).toBe(false)
    expect(autoFromLocalLibrary([flat([spec({ design: 'TN10', skuIs: 'TN10-Red Wine' })])], line({ sku: 'TN10-RED WINE' }))).toBe(true)
  })

  it('keeps orders before the cut on their old files', () => {
    expect(autoFromLocalLibrary([flat([spec()])], line({ orderNumber: '#LIT5742' }))).toBe(false)
  })

  it('needs the entry to be READY', () => {
    expect(autoFromLocalLibrary([flat([spec()], { status: 'NEEDS_REVIEW' })], line())).toBe(false)
  })

  it('a spec nobody personalises, or one that may print blank, needs no name', () => {
    expect(autoFromLocalLibrary([flat([spec({ fields: [] })])], line({ personalization: [] }))).toBe(true)
    expect(autoFromLocalLibrary([flat([spec({ noTextOk: true })])], line({ personalization: [] }))).toBe(true)
  })

  it('reads a choice spec, and leaves two matching choices to a person', () => {
    const a = spec({ match: { 'Choose Color': 'Option 5' } }); const b = spec({ match: { 'Choose Color': 'Option 3' } })
    const chose = (...v: string[]) => [...named, ...v.map(value => ({ key: 'Choose Color', value }))]
    expect(autoFromLocalLibrary([flat([a, b])], line({ personalization: chose('Option 5') }))).toBe(true)
    expect(autoFromLocalLibrary([flat([a, b])], line({ personalization: chose('Option 5', 'Option 3') }))).toBe(false)
    expect(autoFromLocalLibrary([flat([a])], line({ personalization: chose('Option 1') }))).toBe(false)
  })
})

describe('a PSD in the local library', () => {
  it('takes a one-area line when the customer filled every field', () => {
    expect(autoFromLocalLibrary([psd()], line({ personalization: [{ key: 'Custom Name', value: 'Jo' }] }))).toBe(true)
    expect(autoFromLocalLibrary([psd()], line({ personalization: [] }))).toBe(false)
  })

  it('takes a lone No, and a design with no field at all (LIT6090_1)', () => {
    expect(autoFromLocalLibrary([psd()], line({ personalization: [{ key: 'Custom Name Yes Or No', value: 'No' }] }))).toBe(true)
    expect(autoFromLocalLibrary([psd({ fields: [] })], line({ personalization: [{ key: 'Custom Name Yes Or No', value: 'No' }] }))).toBe(true)
  })

  it('does not trust a row with no field list or not READY', () => {
    expect(autoFromLocalLibrary([psd({ fields: undefined })], line())).toBe(false)
    expect(autoFromLocalLibrary([psd({ status: 'NEEDS_FONTS' })], line({ personalization: [{ key: 'Custom Name', value: 'Jo' }] }))).toBe(false)
  })
})

describe('designOf', () => {
  it('reads the leading code and the upload form', () => {
    expect(designOf('TN1-Red Wine')).toBe('TN1')
    expect(designOf('upload-C979=DN12')).toBe('DN12')
    expect(designOf(null)).toBe('')
  })
})
