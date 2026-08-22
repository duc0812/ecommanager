import { describe, it, expect } from 'vitest'
import { buildAdLibrarySearchUrl, defaultSearchTerm } from './ad-search-url'

describe('buildAdLibrarySearchUrl', () => {
  it('builds an Ad Library keyword-search URL with encoded term and country', () => {
    const url = buildAdLibrarySearchUrl('family store', 'US')
    expect(url).toBe('https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&q=family%20store&search_type=keyword_unordered&media_type=all')
  })
  it('defaults country to ALL', () => {
    expect(buildAdLibrarySearchUrl('familystore')).toContain('country=ALL')
    expect(buildAdLibrarySearchUrl('familystore')).toContain('q=familystore')
  })
})

describe('defaultSearchTerm', () => {
  it('keeps the full domain including TLD (strips only www)', () => {
    expect(defaultSearchTerm('familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('www.familystore.com')).toBe('familystore.com')
    expect(defaultSearchTerm('shop.familystore.co.uk')).toBe('shop.familystore.co.uk')
  })
})
