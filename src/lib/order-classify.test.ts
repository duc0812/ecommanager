import { describe, it, expect } from 'vitest'
import {
  buildPersonalizationSections,
  buildTrelloCardContent,
  isLineCustomized,
  lineFamily,
  mergePersonalizationIntoDesc,
  reduceOrderType,
  PERSONALIZATION_MARKER,
} from '@/lib/order-classify'

describe('isLineCustomized', () => {
  it('true when _print_files present', () => {
    expect(isLineCustomized({ customAttributes: [{ key: '_print_files', value: '[]' }] })).toBe(true)
  })
  it('true when previewCdnUrl present', () => {
    expect(isLineCustomized({ customAttributes: [], previewCdnUrl: 'http://p' })).toBe(true)
  })
  it('false when only the product carries a Custom Name tag (tags are not a signal)', () => {
    expect(isLineCustomized({ customAttributes: [], previewCdnUrl: null })).toBe(false)
  })
  it('true when an external custom field is present (e.g. YOUR NAME)', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'YOUR NAME', value: 'Janice' }] })).toBe(true)
  })
  it('false for a variant-selector property (Size) with no other signal', () => {
    expect(isLineCustomized({ customAttributes: [{ key: 'Size', value: 'M' }], previewCdnUrl: null })).toBe(false)
  })
  it('false when only hidden non-custom props and no preview', () => {
    expect(isLineCustomized({ customAttributes: [{ key: '_ll_id', value: 'x' }], previewCdnUrl: null })).toBe(false)
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

// Real shape of #LIT3548: classified CUSTOM purely from visible line-item properties,
// with none of the Customily/_customall_* keys the card builder used to look for.
const visiblePropsLine = {
  sku: 'DN1907262114-HOODIE, BLACK-PURPLE, 3XL',
  productTitle: 'Personalized Jeep Dog Girl Multicolor Fleece Zip Hoodie-DN1907262114',
  customAttributes: [
    { key: 'Custom Name: Yes Or No?', value: 'Yes' },
    { key: 'Custom Name/Text', value: 'Krissi' },
  ],
  productTags: ['Custom Name'],
  variantTitle: 'Hoodie / Purple / 3XL',
  qty: 1,
}

describe('buildTrelloCardContent surfaces the customer input designers must print', () => {
  it('CUSTOM: shows the visible properties that made the line custom', () => {
    const { desc } = buildTrelloCardContent('#LIT3548', [visiblePropsLine], 'CUSTOM')
    expect(desc).toContain('Custom Name/Text: Krissi')
  })

  it('CUSTOM: every property that triggers isLineCustomized ends up on the card', () => {
    expect(isLineCustomized(visiblePropsLine)).toBe(true)
    const { desc } = buildTrelloCardContent('#LIT3548', [visiblePropsLine], 'CUSTOM')
    for (const a of visiblePropsLine.customAttributes) expect(desc).toContain(a.value)
  })

  it('CUSTOM: skips variant-selector props already shown in the SKU/variant heading', () => {
    const line = {
      ...visiblePropsLine,
      customAttributes: [{ key: 'Size', value: '3XL' }, { key: 'Custom Name/Text', value: 'Krissi' }],
    }
    const { desc } = buildTrelloCardContent('#LIT3548', [line], 'CUSTOM')
    expect(desc).toContain('Krissi')
    expect(desc).not.toContain('Size: 3XL')
  })

  it('CUSTOM: hides internal "_"-prefixed app props from the personalization list', () => {
    const line = {
      ...visiblePropsLine,
      customAttributes: [{ key: '_ll_id', value: 'abc123' }, { key: 'Custom Name/Text', value: 'Krissi' }],
    }
    const { desc } = buildTrelloCardContent('#LIT3548', [line], 'CUSTOM')
    expect(desc).not.toContain('_ll_id')
  })

  it('CUSTOM: picks up a labelled preview URL, not only _customall_preview', () => {
    const line = {
      ...visiblePropsLine,
      customAttributes: [{ key: 'Preview Image', value: 'https://cdn.example/p.png' }],
    }
    const { desc } = buildTrelloCardContent('#LIT3548', [line], 'CUSTOM')
    expect(desc).toContain('Preview: https://cdn.example/p.png')
  })

  it('MIXED orders fall into the NON_CUSTOM branch — the custom line still shows its input', () => {
    const { desc } = buildTrelloCardContent('#LIT3548', [visiblePropsLine], 'NON_CUSTOM')
    expect(desc).toContain('Custom Name/Text: Krissi')
  })

  it('adds no personalization block when the line carries no customer input', () => {
    const line = { ...visiblePropsLine, customAttributes: [] }
    const { desc } = buildTrelloCardContent('#LIT3548', [line], 'CUSTOM')
    expect(desc).not.toContain('Personalization')
  })
})

describe('buildPersonalizationSections (backfill of already-created cards)', () => {
  const line = {
    sku: 'DN1907262114-HOODIE, BLACK-PURPLE, 3XL',
    productTitle: 'Personalized Jeep Dog Girl Fleece Zip Hoodie',
    variantTitle: 'Hoodie / Purple / 3XL',
    shopifyProductType: '2D Cothing',
    customAttributes: [
      { key: 'Custom Name: Yes Or No?', value: 'Yes' },
      { key: 'Custom Name/Text', value: 'Krissi' },
    ],
  }

  it('labels each product line with the drive-attachment key so it matches the card body', () => {
    const block = buildPersonalizationSections('#LIT3548', [line])
    expect(block).toContain('(LIT3548_1)')
    expect(block).toContain('Custom Name/Text: Krissi')
  })

  it('numbers product lines only, and marks digital add-ons separately', () => {
    const addOn = {
      sku: null,
      productTitle: 'Custom Text',
      variantTitle: 'Add Text',
      shopifyProductType: 'Custom Text',
      customAttributes: [{ key: 'Text', value: 'Happy Birthday' }],
    }
    const block = buildPersonalizationSections('#LIT3548', [addOn, line]) ?? ''
    expect(block).toContain('(add-on)')
    expect(block).toContain('Happy Birthday')
    expect(block).toContain('(LIT3548_1)')
    expect(block).not.toContain('(LIT3548_2)')
  })

  it('returns null when nothing was personalized', () => {
    expect(buildPersonalizationSections('#LIT3548', [{ ...line, customAttributes: [] }])).toBeNull()
  })

  it('indents multi-line customer text so the list stays readable', () => {
    const block = buildPersonalizationSections('#LIT3548', [
      { ...line, customAttributes: [{ key: 'Message', value: 'Line one\nLine two' }] },
    ]) ?? ''
    expect(block).toContain('  - Message: Line one\n    Line two')
  })
})

describe('mergePersonalizationIntoDesc', () => {
  const block = `${PERSONALIZATION_MARKER}\n\n**1. SKU1** (1234_1)\n  - Name: Krissi`

  it('appends below the existing card body', () => {
    const merged = mergePersonalizationIntoDesc('Design missing — prepare per-supplier design:', block)
    expect(merged).toContain('Design missing')
    expect(merged).toContain('Krissi')
  })

  it('is idempotent — re-running replaces the old block instead of stacking copies', () => {
    const once = mergePersonalizationIntoDesc('Existing body', block)
    const twice = mergePersonalizationIntoDesc(once, block)
    expect(twice).toBe(once)
    expect(twice.split(PERSONALIZATION_MARKER).length - 1).toBe(1)
  })

  it('refreshes a stale block when the customer input changed', () => {
    const once = mergePersonalizationIntoDesc('Existing body', block)
    const updated = mergePersonalizationIntoDesc(once, block.replace('Krissi', 'Janice'))
    expect(updated).toContain('Janice')
    expect(updated).not.toContain('Krissi')
  })

  it('handles an empty card body without a leading separator', () => {
    expect(mergePersonalizationIntoDesc('', block)).toBe(block)
  })
})
