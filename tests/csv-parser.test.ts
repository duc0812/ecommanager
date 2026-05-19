import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/lib/csv-parser'

describe('parseCsv', () => {
  it('parses simple comma-separated rows with header', () => {
    const input = 'sku,baseCost\nA,10\nB,20'
    expect(parseCsv(input)).toEqual([
      { sku: 'A', baseCost: '10' },
      { sku: 'B', baseCost: '20' },
    ])
  })

  it('handles quoted fields with embedded commas', () => {
    const input = 'sku,note\nA,"Hello, world"\nB,plain'
    expect(parseCsv(input)).toEqual([
      { sku: 'A', note: 'Hello, world' },
      { sku: 'B', note: 'plain' },
    ])
  })

  it('handles escaped quotes inside quoted fields', () => {
    const input = 'name,note\n"He said ""hi""",foo'
    expect(parseCsv(input)).toEqual([
      { name: 'He said "hi"', note: 'foo' },
    ])
  })

  it('skips empty lines', () => {
    const input = 'sku,baseCost\nA,10\n\nB,20\n'
    expect(parseCsv(input)).toEqual([
      { sku: 'A', baseCost: '10' },
      { sku: 'B', baseCost: '20' },
    ])
  })

  it('handles CRLF line endings', () => {
    const input = 'sku,baseCost\r\nA,10\r\nB,20\r\n'
    expect(parseCsv(input)).toEqual([
      { sku: 'A', baseCost: '10' },
      { sku: 'B', baseCost: '20' },
    ])
  })
})
