import { describe, it, expect } from 'vitest'
import { buildAdLibrarySearchUrl, defaultSearchTerm } from './ad-search-url'

describe('buildAdLibrarySearchUrl', () => {
  it('builds an exact-phrase Ad Library URL with a quoted, encoded term and country', () => {
    const url = buildAdLibrarySearchUrl('family store', 'US')
    expect(url).toBe('https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=%22family%20store%22&search_type=keyword_exact_phrase&media_type=all')
  })
  it('defaults country to ALL and wraps the term in quotes', () => {
    expect(buildAdLibrarySearchUrl('familystore.com')).toContain('country=ALL')
    expect(buildAdLibrarySearchUrl('familystore.com')).toContain('q=%22familystore.com%22')
    expect(buildAdLibrarySearchUrl('familystore.com')).toContain('search_type=keyword_exact_phrase')
  })
})

describe('defaultSearchTerm', () => {
  it('keeps the full domain including TLD (strips only www)', () => {
    expect(defaultSearchTerm('familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('www.familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('shop.familystore.co.uk')).toBe('shop.familystore.co.uk')
  })
})
