import { describe, it, expect } from 'vitest'
import { parseSheetsJson, DEFAULT_STORE_BASE } from './auto-fulfill-sheets'

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
