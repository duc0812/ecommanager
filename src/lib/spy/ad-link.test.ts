import { describe, it, expect } from 'vitest'
import { parseAdLink } from './ad-link'

describe('parseAdLink', () => {
  it('classifies a product link and extracts the handle (strips www)', () => {
    expect(parseAdLink('https://www.mystore.com/products/cool-shirt?variant=1'))
      .toEqual({ host: 'mystore.com', kind: 'product', handle: 'cool-shirt' })
  })
  it('classifies collection / homepage / other', () => {
    expect(parseAdLink('https://mystore.com/collections/summer').kind).toBe('collection')
    expect(parseAdLink('https://mystore.com/').kind).toBe('homepage')
    expect(parseAdLink('https://mystore.com').kind).toBe('homepage')
    expect(parseAdLink('https://mystore.com/pages/about').kind).toBe('other')
  })
  it('unwraps a Facebook redirect (l.facebook.com?u=)', () => {
    const real = encodeURIComponent('https://mystore.com/products/hat')
    expect(parseAdLink(`https://l.facebook.com/l.php?u=${real}&h=abc`))
      .toEqual({ host: 'mystore.com', kind: 'product', handle: 'hat' })
  })
  it('returns nulls for empty or invalid input', () => {
    expect(parseAdLink(null)).toEqual({ host: null, kind: null, handle: null })
    expect(parseAdLink('not a url')).toEqual({ host: null, kind: null, handle: null })
  })
})
