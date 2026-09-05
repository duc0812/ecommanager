import { describe, it, expect } from 'vitest'
import { parseSheetsJson, DEFAULT_STORE_BASE, coerceMinAgeDays, DEFAULT_MIN_AGE_DAYS } from './auto-fulfill-sheets'

describe('parseSheetsJson', () => {
  it('returns [] for null / invalid JSON', () => {
    expect(parseSheetsJson(null)).toEqual([])
    expect(parseSheetsJson('not json')).toEqual([])
  })
  it('fills defaults for missing fields', () => {
    const out = parseSheetsJson(JSON.stringify([{ id: '1', name: 'Sup A', url: 'u' }]))
    expect(out).toEqual([{ id: '1', name: 'Sup A', url: 'u', enabled: true, storeBase: DEFAULT_STORE_BASE }])
  })
  it('drops entries without a url', () => {
    expect(parseSheetsJson(JSON.stringify([{ id: '1', name: 'x' }]))).toEqual([])
  })
})

describe('coerceMinAgeDays', () => {
  it('falls back to the default for non-finite input', () => {
    expect(coerceMinAgeDays('abc')).toBe(DEFAULT_MIN_AGE_DAYS)
    expect(coerceMinAgeDays(DEFAULT_MIN_AGE_DAYS)).toBe(5)
  })
  it('floors and clamps valid numbers to >= 0', () => {
    expect(coerceMinAgeDays(0)).toBe(0)
    expect(coerceMinAgeDays(7)).toBe(7)
    expect(coerceMinAgeDays(-3)).toBe(0)
    expect(coerceMinAgeDays(3.9)).toBe(3)
  })
})
