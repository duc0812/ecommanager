import { describe, it, expect } from 'vitest'
import { buildTrelloCardContent, isLineCustomized, lineFamily, reduceOrderType } from '@/lib/order-classify'

describe('isLineCustomized', () => {
  it('true when _print_files present', () => {
    expect(isLineCustomized({ customAttributes: [{ key: '_print_files', value: '[]' }] })).toBe(true)
  })
  it('true when previewCdnUrl present', () => {
    expect(isLineCustomized({ customAttributes: [], previewCdnUrl: 'http://p' })).toBe(true)
  })
  it('true when product tagged Custom Name', () => {
    expect(isLineCustomized({ customAttributes: [], productTags: ['phone case', 'Custom Name'] })).toBe(true)
  })
  it('true when an external custom field is present (e.g. YOUR NAME)', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'YOUR NAME', value: 'Janice' }] })).toBe(true)
  })
  it('false for a variant-selector property (Size) with no other signal', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'Size', value: 'M' }], previewCdnUrl: null })).toBe(false)
  })
  it('false when only hidden non-custom props and no tag/preview', () => {
    expect(isLineCustomized({ customAttributes: [{ key: '_ll_id', value: 'x' }], previewCdnUrl: null, productTags: ['phone case'] })).toBe(false)
  })
  it('false for a non-_ property with a blank value', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'Custom Note', value: '  ' }], previewCdnUrl: null })).toBe(false)
  })
})

describe('lineFamily', () => {
  it('customized => CUSTOM regardless of type', () => {
    expect(lineFamily({ customized: true, designType: 'DUAL' })).toBe('CUSTOM')
  })
  it('DUAL type not customized => DUAL', () => {
    expect(lineFamily({ customized: false, designType: 'DUAL' })).toBe('DUAL')
  })
  it('otherwise NON_CUSTOM', () => {
    expect(lineFamily({ customized: false, designType: 'NON_CUSTOM' })).toBe('NON_CUSTOM')
  })
})

describe('reduceOrderType', () => {
  it('empty => UNKNOWN', () => { expect(reduceOrderType([])).toBe('UNKNOWN') })
  it('all same => that family', () => {
    expect(reduceOrderType(['NON_CUSTOM', 'NON_CUSTOM'])).toBe('NON_CUSTOM')
    expect(reduceOrderType(['DUAL'])).toBe('DUAL')
    expect(reduceOrderType(['CUSTOM', 'CUSTOM'])).toBe('CUSTOM')
  })
  it('mixed families => MIXED', () => {
    expect(reduceOrderType(['CUSTOM', 'NON_CUSTOM'])).toBe('MIXED')
    expect(reduceOrderType(['DUAL', 'NON_CUSTOM'])).toBe('MIXED')
  })
})

describe('buildTrelloCardContent NON_CUSTOM with supplier hints', () => {
  it('lists supplier + template ref + master artwork per SKU', () => {
    const lines = [{
      sku: 'SKU1', productTitle: 'Tee', customAttributes: [], productTags: [],
      variantTitle: 'M', qty: 1, supplierName: 'Printful', designTemplateUrl: 'http://tpl/pf',
    }]
    const master = new Map<string, string | null>([['SKU1', 'http://master/1']])
    const { desc } = buildTrelloCardContent('#1023', lines, 'NON_CUSTOM', master)
    expect(desc).toContain('SKU1')
    expect(desc).toContain('Printful')
    expect(desc).toContain('http://tpl/pf')
    expect(desc).toContain('http://master/1')
  })
})

const physicalLine = {
  sku: 'LIT2570',
  productTitle: 'Custom Name Necklace',
  customAttributes: [{ key: '_print_files', value: '[]' }],
  productTags: [],
  variantTitle: 'Gold',
  qty: 1,
}

const customTextLine = {
  sku: 'LIT2570_1',
  productTitle: 'Custom Text',
  customAttributes: [{ key: 'Text', value: 'Happy Birthday' }],
  productTags: [],
  variantTitle: 'Add Text',
  qty: 1,
}

describe('buildTrelloCardContent with digital Custom Text line', () => {
  it('numbers drive attachments only over physical lines (CUSTOM)', () => {
    const { desc } = buildTrelloCardContent('#1234', [physicalLine, customTextLine], 'CUSTOM')
    expect(desc).toContain('Drive attachment name: 1234_1')
    expect(desc).not.toContain('Drive attachment name: 1234_2')
  })

  it('still mentions the Custom Text add-on so designers see it (CUSTOM)', () => {
    const { desc } = buildTrelloCardContent('#1234', [physicalLine, customTextLine], 'CUSTOM')
    expect(desc).toContain('Custom Text')
    expect(desc).toContain('Happy Birthday')
  })

  it('excludes digital sku from NON_CUSTOM design sku list', () => {
    const { desc } = buildTrelloCardContent('#1234', [physicalLine, customTextLine], 'NON_CUSTOM')
    expect(desc).toContain('1. LIT2570 (1234_1)')
    expect(desc).not.toContain('LIT2570_1 (1234_2)')
  })

  it('keeps card name based on physical skus', () => {
    const { name } = buildTrelloCardContent('#1234', [physicalLine, customTextLine], 'CUSTOM')
    expect(name).toContain('LIT2570')
  })
})
