import { describe, it, expect } from 'vitest'
import { parseCronConfig, cronExpr, DEFAULT_CRON } from './cron-config'

describe('parseCronConfig', () => {
  it('returns defaults for null/invalid', () => {
    expect(parseCronConfig(null)).toEqual(DEFAULT_CRON)
    expect(parseCronConfig('not json')).toEqual(DEFAULT_CRON)
  })
  it('merges + clamps + dedupes + sorts hours', () => {
    const c = parseCronConfig(JSON.stringify({ productBestSeller: { enabled: false, hours: [20, 8, 8, 30, -1] }, ads: { enabled: true, hours: [9] } }))
    expect(c.productBestSeller).toEqual({ enabled: false, hours: [8, 20] })
    expect(c.ads).toEqual({ enabled: true, hours: [9] })
  })
  it('keeps an explicitly empty hours array', () => {
    expect(parseCronConfig(JSON.stringify({ ads: { enabled: true, hours: [] } })).ads.hours).toEqual([])
  })
})
describe('cronExpr', () => {
  it('builds a daily expr', () => { expect(cronExpr([8, 20])).toBe('0 8,20 * * *') })
  it('returns null for empty', () => { expect(cronExpr([])).toBeNull() })
})
