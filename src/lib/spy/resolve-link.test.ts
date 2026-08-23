import { describe, it, expect, vi, beforeEach } from 'vitest'

const store: any = { findManyResult: [], updateMany: [], update: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyAd: {
      findMany: vi.fn(async () => store.findManyResult),
      updateMany: vi.fn(async (a: any) => { store.updateMany.push(a); return { count: a.where.id.in.length } }),
      update: vi.fn(async (a: any) => { store.update.push(a); return {} }),
    },
  },
}))

import { needsResolution, resolveRedirect, resolvePendingAdLinks } from './resolve-link'

beforeEach(() => {
  store.findManyResult = []; store.updateMany.length = 0; store.update.length = 0
  vi.clearAllMocks(); vi.unstubAllGlobals()
})

describe('needsResolution', () => {
  it('true for a coded/short path (parsed kind "other")', () => {
    expect(needsResolution('https://familystore.com/CT6082038')).toBe(true)
  })
  it('false for product / collection / homepage / null / non-http', () => {
    expect(needsResolution('https://familystore.com/products/spooky-quilt')).toBe(false)
    expect(needsResolution('https://familystore.com/collections/all')).toBe(false)
    expect(needsResolution('https://familystore.com/')).toBe(false)
    expect(needsResolution('https://familystore.com')).toBe(false)
    expect(needsResolution(null)).toBe(false)
    expect(needsResolution('not a url')).toBe(false)
    expect(needsResolution('ftp://host/path')).toBe(false)
  })
})

describe('resolveRedirect', () => {
  it('returns the final url and drains the body', async () => {
    const cancel = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://familystore.com/products/xyz', body: { cancel } })))
    const out = await resolveRedirect('https://familystore.com/CT1')
    expect(out).toBe('https://familystore.com/products/xyz')
    expect(cancel).toHaveBeenCalled()
  })
  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    expect(await resolveRedirect('https://x/y')).toBeNull()
  })
})

describe('resolvePendingAdLinks', () => {
  it('marks non-needing ads checked, resolves needing ads, counts results', async () => {
    store.findManyResult = [
      { id: 'a1', linkUrl: 'https://familystore.com/CT1' },
      { id: 'a2', linkUrl: 'https://familystore.com/products/p' },
      { id: 'a3', linkUrl: 'https://familystore.com/' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://familystore.com/products/resolved', body: null })))
    const res = await resolvePendingAdLinks({ concurrency: 2 })
    expect(res.checked).toBe(3)
    expect(res.network).toBe(1)
    expect(res.resolved).toBe(1)
    expect([...store.updateMany[0].where.id.in].sort()).toEqual(['a2', 'a3'])
    const upd = store.update.find((u: any) => u.where.id === 'a1')
    expect(upd.data.resolvedUrl).toBe('https://familystore.com/products/resolved')
    expect(upd.data.linkResolvedAt).toBeInstanceOf(Date)
  })

  it('stores null resolvedUrl when the redirect lands on the same url', async () => {
    store.findManyResult = [{ id: 'b1', linkUrl: 'https://familystore.com/CT2' }]
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://familystore.com/CT2', body: null })))
    const res = await resolvePendingAdLinks()
    expect(res.resolved).toBe(0)
    expect(store.update[0].data.resolvedUrl).toBeNull()
    expect(store.update[0].data.linkResolvedAt).toBeInstanceOf(Date)
  })

  it('caps network resolutions and leaves the rest for a later run', async () => {
    store.findManyResult = [
      { id: 'c1', linkUrl: 'https://familystore.com/CT1' },
      { id: 'c2', linkUrl: 'https://familystore.com/CT2' },
      { id: 'c3', linkUrl: 'https://familystore.com/CT3' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://familystore.com/products/x', body: null })))
    const res = await resolvePendingAdLinks({ networkCap: 2 })
    expect(res.network).toBe(2)
    expect(store.update).toHaveLength(2)
    expect(store.updateMany).toHaveLength(0)
  })
})
