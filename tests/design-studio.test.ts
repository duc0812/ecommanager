import { describe, it, expect } from 'vitest'
import { parseAttributes, printAreasForLine, safeHttpUrl, sourcePrintFiles } from '@/lib/design-studio'

const PF = JSON.stringify([
  { print_area: 'Front', url: 'https://cdn.example/front.png' },
  { print_area: 'Back', url: 'https://cdn.example/back.png' },
])

describe('parseAttributes', () => {
  it('returns [] for null or broken JSON', () => {
    expect(parseAttributes(null)).toEqual([])
    expect(parseAttributes('{nope')).toEqual([])
  })
  it('keeps only {key, value} string pairs', () => {
    expect(parseAttributes(JSON.stringify([{ key: 'A', value: 'x' }, { key: 1 }, 'junk']))).toEqual([{ key: 'A', value: 'x' }])
  })
})

describe('sourcePrintFiles', () => {
  it('reads _print_files entries', () => {
    expect(sourcePrintFiles([{ key: '_print_files', value: PF }])).toEqual([
      { printArea: 'Front', url: 'https://cdn.example/front.png' },
      { printArea: 'Back', url: 'https://cdn.example/back.png' },
    ])
  })
  it('falls back to _customall_print_file as "Print"', () => {
    expect(sourcePrintFiles([{ key: '_customall_print_file', value: 'https://cdn.example/p.png' }]))
      .toEqual([{ printArea: 'Print', url: 'https://cdn.example/p.png' }])
  })
  it('ignores malformed JSON', () => {
    expect(sourcePrintFiles([{ key: '_print_files', value: '[{"url":' }])).toEqual([])
  })
})

describe('printAreasForLine', () => {
  it('names slots after _print_files areas', () => {
    expect(printAreasForLine([{ key: '_print_files', value: PF }])).toEqual(['Front', 'Back'])
  })
  it('falls back to Artwork when there are no areas or no names', () => {
    expect(printAreasForLine([])).toEqual(['Artwork'])
    expect(printAreasForLine([{ key: '_print_files', value: JSON.stringify([{ url: 'x' }]) }])).toEqual(['Artwork'])
    expect(printAreasForLine([{ key: '_print_files', value: 'not json' }])).toEqual(['Artwork'])
  })
  it('dedupes repeated area names', () => {
    const dup = JSON.stringify([{ print_area: 'print', url: 'a' }, { print_area: 'print', url: 'b' }])
    expect(printAreasForLine([{ key: '_print_files', value: dup }])).toEqual(['print'])
  })
})

describe('safeHttpUrl', () => {
  it('keeps http(s) URLs and drops everything else', () => {
    expect(safeHttpUrl('https://x.y/p')).toBe('https://x.y/p')
    expect(safeHttpUrl('http://x.y/p')).toBe('http://x.y/p')
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('JavaScript:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(safeHttpUrl('not a url')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
    expect(safeHttpUrl(undefined)).toBeNull()
  })
})
