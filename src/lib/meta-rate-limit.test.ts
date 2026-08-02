import { describe, expect, it } from 'vitest'
import { isMetaRateLimitError, metaPageDelayMs, parseMetaUsagePercent } from './meta-rate-limit'

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? values[name.toLowerCase()] ?? null }
}

describe('Meta rate limiting', () => {
  it('reads the highest usage value from app and business headers', () => {
    expect(parseMetaUsagePercent(headers({
      'x-app-usage': JSON.stringify({ call_count: 42, total_cputime: 61, total_time: 20 }),
      'x-business-use-case-usage': JSON.stringify({ act_1: [{ type: 'ads_management', call_count: 78, total_cputime: 12, total_time: 9 }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 84 }),
    }))).toBe(84)
  })

  it('ignores malformed or missing usage headers', () => {
    expect(parseMetaUsagePercent(headers({ 'x-app-usage': 'not-json' }))).toBeNull()
  })

  it('uses increasingly conservative delays', () => {
    expect(metaPageDelayMs(null)).toBe(1_000)
    expect(metaPageDelayMs(70)).toBe(3_000)
    expect(metaPageDelayMs(85)).toBe(10_000)
    expect(metaPageDelayMs(95)).toBe(30_000)
  })

  it('recognizes HTTP and Graph API rate-limit errors', () => {
    expect(isMetaRateLimitError(429, null)).toBe(true)
    expect(isMetaRateLimitError(400, { code: 613 })).toBe(true)
    expect(isMetaRateLimitError(400, { message: 'Application request limit reached' })).toBe(true)
    expect(isMetaRateLimitError(400, { code: 190, message: 'Token expired' })).toBe(false)
  })
})
