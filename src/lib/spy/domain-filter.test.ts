import { describe, it, expect } from 'vitest'
import { bareDomain, domainVariants } from '@/lib/spy/domain-filter'

describe('bareDomain', () => {
  it('lowercases and strips protocol, path, and www', () => {
    expect(bareDomain('https://WWW.FamilyStore.com/collections')).toBe('familystore.com')
    expect(bareDomain('familystore.com')).toBe('familystore.com')
    expect(bareDomain('www.homesizy.com')).toBe('homesizy.com')
  })
  it('returns empty string for blank input', () => {
    expect(bareDomain('   ')).toBe('')
  })
})

describe('domainVariants', () => {
  it('returns the bare and www-prefixed variants', () => {
    expect(domainVariants('familystore.com')).toEqual(['familystore.com', 'www.familystore.com'])
    expect(domainVariants('www.familystore.com')).toEqual(['familystore.com', 'www.familystore.com'])
  })
  it('returns [] for blank input', () => {
    expect(domainVariants('')).toEqual([])
  })
})
