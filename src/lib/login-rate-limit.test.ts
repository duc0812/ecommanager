import { describe, expect, it } from 'vitest'
import { clearLoginFailures, loginBlocked, recordLoginFailure } from './login-rate-limit'

describe('login rate limit', () => {
  it('blocks after 10 failures within the window and resets after it', () => {
    const key = 'email:test@example.com'
    const t0 = 1_000_000
    for (let i = 0; i < 9; i++) recordLoginFailure(key, t0)
    expect(loginBlocked(key, t0)).toBe(false)
    recordLoginFailure(key, t0)
    expect(loginBlocked(key, t0 + 1000)).toBe(true)
    expect(loginBlocked(key, t0 + 16 * 60 * 1000)).toBe(false)
    clearLoginFailures(key)
    expect(loginBlocked(key, t0)).toBe(false)
  })
})
