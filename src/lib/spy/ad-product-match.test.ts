import { describe, it, expect, vi, beforeEach } from 'vitest'

const findMany = vi.fn()
vi.mock('@/lib/db', () => ({ prisma: { spyProduct: { findMany: (...a: any[]) => findMany(...a) } } }))

import { recentLaunchSet } from './ad-product-match'

beforeEach(() => { findMany.mockReset() })

describe('recentLaunchSet', () => {
  it('queries by distinct hosts+handles and returns domain|handle keys', async () => {
    findMany.mockResolvedValueOnce([{ handle: 'hat', store: { domain: 'mystore.com' } }])
    const set = await recentLaunchSet([
      'https://www.mystore.com/products/hat',
      'https://mystore.com/collections/x', // not a product → ignored
      null,
    ])
    expect(set.has('mystore.com|hat')).toBe(true)
    const arg = findMany.mock.calls[0][0]
    expect(arg.where.handle.in).toEqual(['hat'])
    expect(arg.where.store.domain.in).toEqual(['mystore.com', 'www.mystore.com'])
  })
  it('skips the query and returns empty when no product links', async () => {
    const set = await recentLaunchSet(['https://mystore.com/', null])
    expect(set.size).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
  })
  it('www-stored domain produces bare-host key', async () => {
    findMany.mockResolvedValueOnce([{ handle: 'hat', store: { domain: 'www.mystore.com' } }])
    const set = await recentLaunchSet(['https://www.mystore.com/products/hat'])
    expect(set.has('mystore.com|hat')).toBe(true)
  })
})
