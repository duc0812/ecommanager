import { describe, expect, it } from 'vitest'
import { orderPrefixOf } from './order-prefix'

describe('orderPrefixOf', () => {
  it('is the letters right before the number, upper-cased', () => {
    expect(orderPrefixOf('#REMI1010')).toBe('REMI')
    expect(orderPrefixOf('LIT4665')).toBe('LIT')
    expect(orderPrefixOf('#lit9')).toBe('LIT')
    expect(orderPrefixOf('  #Lit9R1 ')).toBe('LIT')
    expect(orderPrefixOf('LITE123')).toBe('LITE')
  })

  it('is null when a separator, no letters or no number comes after them', () => {
    expect(orderPrefixOf('#REMI-1010')).toBeNull()
    expect(orderPrefixOf('#REMI 1010')).toBeNull()
    expect(orderPrefixOf('#1001')).toBeNull()
    expect(orderPrefixOf('REMI')).toBeNull()
    expect(orderPrefixOf('')).toBeNull()
    expect(orderPrefixOf(null)).toBeNull()
    expect(orderPrefixOf(undefined)).toBeNull()
  })
})
