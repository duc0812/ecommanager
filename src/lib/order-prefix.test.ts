import { describe, expect, it } from 'vitest'
import { orderPrefixOf, storeForOrderName } from './order-prefix'

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

describe('storeForOrderName', () => {
  const lit = { id: 'a', orderPrefix: 'LIT' }
  const remi = { id: 'b', orderPrefix: 'remi' }
  const bare = { id: 'c', orderPrefix: null }

  it('is the store whose prefix the order name carries, whatever the case, #, line suffix or R-revision', () => {
    expect(storeForOrderName('LIT4665', [lit, remi])).toBe(lit)
    expect(storeForOrderName('#REMI1010', [lit, remi])).toBe(remi)
    expect(storeForOrderName('LIT4665_2', [lit, remi])).toBe(lit)
    expect(storeForOrderName('#lit2362R1', [lit, remi])).toBe(lit)
  })

  it('is null for a name no store owns: a longer prefix, no prefix, a separator, a store without a prefix', () => {
    expect(storeForOrderName('LITE123', [lit, remi])).toBeNull()
    expect(storeForOrderName('ZZZ9', [lit, remi])).toBeNull()
    expect(storeForOrderName('#1001', [lit, remi, bare])).toBeNull()
    expect(storeForOrderName('#REMI-1010', [lit, remi])).toBeNull()
    expect(storeForOrderName('LIT1', [bare])).toBeNull()
    expect(storeForOrderName('LIT1', [])).toBeNull()
  })

  it('is null when two stores claim the same prefix, so a row is never guessed onto one of them', () => {
    expect(storeForOrderName('LIT1', [lit, { id: 'd', orderPrefix: 'Lit' }])).toBeNull()
  })

  it('does not pick the only store for a name without its prefix', () => {
    expect(storeForOrderName('#1001', [lit])).toBeNull()
    expect(storeForOrderName('REMI1', [lit])).toBeNull()
  })
})
