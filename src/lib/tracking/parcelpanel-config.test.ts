import { describe, it, expect } from 'vitest'
import { maskApiKey } from './parcelpanel-config'

describe('maskApiKey', () => {
  it('shows first 4 and last 4 for a normal key', () => {
    expect(maskApiKey('51e5145b-7ce8-4be9-8841-91823dffb061')).toBe('51e5…b061')
  })

  it('returns null for empty / null', () => {
    expect(maskApiKey('')).toBeNull()
    expect(maskApiKey(null)).toBeNull()
    expect(maskApiKey(undefined)).toBeNull()
  })

  it('does not reveal a short key, masks it fully', () => {
    expect(maskApiKey('abcd')).toBe('••••')
    expect(maskApiKey('abcdefg')).toBe('•••••••')
  })
})
