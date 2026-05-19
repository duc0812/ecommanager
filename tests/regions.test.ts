import { describe, it, expect } from 'vitest'
import { resolveZone, REGIONS, DEFAULT_ZONE_COUNTRIES } from '@/lib/regions'

describe('resolveZone', () => {
  it('returns US for US country code', () => {
    expect(resolveZone('US')).toBe('US')
  })

  it('returns EU for German country code', () => {
    expect(resolveZone('DE')).toBe('EU')
  })

  it('returns EU for several other EU country codes', () => {
    expect(resolveZone('FR')).toBe('EU')
    expect(resolveZone('IT')).toBe('EU')
    expect(resolveZone('ES')).toBe('EU')
    expect(resolveZone('NL')).toBe('EU')
  })

  it('returns GB for GB or UK', () => {
    expect(resolveZone('GB')).toBe('GB')
    expect(resolveZone('UK')).toBe('GB')
  })

  it('returns CA for CA', () => {
    expect(resolveZone('CA')).toBe('CA')
  })

  it('returns ROW for non-mapped country', () => {
    expect(resolveZone('JP')).toBe('ROW')
    expect(resolveZone('AU')).toBe('ROW')
    expect(resolveZone('VN')).toBe('ROW')
  })

  it('returns ROW for null or undefined country', () => {
    expect(resolveZone(null)).toBe('ROW')
    expect(resolveZone(undefined)).toBe('ROW')
  })

  it('handles lowercase input', () => {
    expect(resolveZone('us')).toBe('US')
    expect(resolveZone('de')).toBe('EU')
  })

  it('uses supplier override when provided', () => {
    expect(resolveZone('NO', { EU: ['NO'] })).toBe('EU')
  })

  it('override priority over default mapping', () => {
    // CH is normally ROW; override puts it in EU
    expect(resolveZone('CH', { EU: ['CH'] })).toBe('EU')
  })

  it('override does not affect unrelated countries', () => {
    expect(resolveZone('DE', { EU: ['NO'] })).toBe('EU')  // DE still EU from default
  })

  it('REGIONS contains expected 5 entries', () => {
    expect(REGIONS).toEqual(['US', 'EU', 'GB', 'CA', 'ROW'])
  })

  it('DEFAULT_ZONE_COUNTRIES.US contains US', () => {
    expect(DEFAULT_ZONE_COUNTRIES.US).toContain('US')
  })
})
