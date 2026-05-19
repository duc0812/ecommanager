import { describe, it, expect } from 'vitest'
import { classifyOrderLines } from '@/lib/order-classify'

type Line = Parameters<typeof classifyOrderLines>[0][number]

const makeLine = (overrides: Partial<Line> = {}): Line => ({
  sku: 'SKU-001',
  productTitle: 'Test Product',
  customAttributes: [],
  productTags: [],
  ...overrides,
})

describe('classifyOrderLines', () => {
  it('returns CUSTOM when any line has _print_files customAttribute', () => {
    const lines = [
      makeLine({
        customAttributes: [
          { key: '_print_files', value: '[{"print_area":"Front","url":"https://cdn.example.com/file.png"}]' },
        ],
      }),
    ]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns CUSTOM when any line product tag includes "Custom Name"', () => {
    const lines = [makeLine({ productTags: ['apparel', 'Custom Name', 'summer'] })]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns NON_CUSTOM when no line has _print_files or Custom Name tag', () => {
    const lines = [
      makeLine({ productTags: ['ceramic', 'handmade'] }),
      makeLine({ sku: 'SKU-002', productTags: ['mug'] }),
    ]
    expect(classifyOrderLines(lines)).toBe('NON_CUSTOM')
  })

  it('returns CUSTOM if at least one line is custom even if others are not', () => {
    const lines = [
      makeLine({ productTags: ['ceramic'] }),
      makeLine({ customAttributes: [{ key: '_print_files', value: '[]' }] }),
    ]
    expect(classifyOrderLines(lines)).toBe('CUSTOM')
  })

  it('returns NON_CUSTOM for empty lines array', () => {
    expect(classifyOrderLines([])).toBe('NON_CUSTOM')
  })

  it('ignores other customAttribute keys that are not _print_files', () => {
    const lines = [
      makeLine({ customAttributes: [{ key: '_kaching_cart', value: '{}' }] }),
    ]
    expect(classifyOrderLines(lines)).toBe('NON_CUSTOM')
  })
})
