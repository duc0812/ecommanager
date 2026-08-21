import { describe, it, expect } from 'vitest'
import { normalizeFbPageUrl } from './fb-url'

describe('normalizeFbPageUrl', () => {
  it('preserves the query string for profile.php?id= pages', () => {
    expect(normalizeFbPageUrl('https://www.facebook.com/profile.php?id=100064123456789'))
      .toBe('https://www.facebook.com/profile.php?id=100064123456789')
  })
  it('accepts a bare vanity page and strips a trailing slash', () => {
    expect(normalizeFbPageUrl('facebook.com/Allbirds/')).toBe('https://facebook.com/Allbirds')
  })
  it('accepts facebook subdomains, rejects non-facebook hosts', () => {
    expect(normalizeFbPageUrl('https://web.facebook.com/Brand')).toBe('https://web.facebook.com/Brand')
    expect(normalizeFbPageUrl('https://evil.com/x')).toBeNull()
    expect(normalizeFbPageUrl('notfacebook.com')).toBeNull()
    expect(normalizeFbPageUrl('')).toBeNull()
  })
})
