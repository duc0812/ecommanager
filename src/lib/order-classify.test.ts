import { describe, it, expect } from 'vitest'
import { buildTrelloCardContent } from '@/lib/order-classify'

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
