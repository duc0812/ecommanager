import { describe, it, expect, beforeAll } from 'vitest'
import { signToken, verifyToken } from './auth'

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
})

describe('signToken / verifyToken', () => {
  it('round-trips user payload', async () => {
    const payload = { userId: 'u1', email: 'a@b.com', name: 'A', role: 'ADMIN', permissions: ['overview'] }
    const token = await signToken(payload as any)
    expect(typeof token).toBe('string')
    const result = await verifyToken(token)
    expect(result?.userId).toBe('u1')
    expect(result?.email).toBe('a@b.com')
    expect(result?.role).toBe('ADMIN')
  })

  it('returns null for invalid token', async () => {
    const result = await verifyToken('not-a-token')
    expect(result).toBeNull()
  })
})
