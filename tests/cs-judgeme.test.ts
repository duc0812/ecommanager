import { describe, it, expect } from 'vitest'
import { JudgemeClient, JudgemeError } from '@/lib/cs/judgeme'

const SHOP = 'caramiaus-store.myshopify.com'
const raw = { id: 7, title: 'Sad', body: 'Still waiting', rating: 1, product_external_id: 8891490140317, product_title: 'Stwa X', product_handle: 'stwa-x', reviewer: { email: 'A@B.com', name: 'Ann' }, verified: 'buyer', hidden: false, created_at: '2026-11-08T10:00:00Z' }

function fakeFetch(status: number, json: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

describe('JudgemeClient', () => {
  it('sends the token header and shop domain', async () => {
    const f = fakeFetch(200, { current_page: 2, per_page: 50, reviews: [] })
    await new JudgemeClient({ token: 'tok', shopDomain: SHOP, fetch: f.fn }).listReviews({ rating: 1, page: 2, perPage: 50 })
    expect(f.calls[0].url).toBe(`https://api.judge.me/api/v1/reviews?rating=1&per_page=50&page=2&shop_domain=${SHOP}`)
    expect(f.calls[0].headers['X-Api-Token']).toBe('tok')
  })
  it('maps a review', async () => {
    const f = fakeFetch(200, { current_page: 1, per_page: 50, reviews: [raw] })
    const [r] = await new JudgemeClient({ token: 'tok', shopDomain: SHOP, fetch: f.fn }).listReviews({ rating: 1, page: 1, perPage: 50 })
    expect(r).toEqual({ id: 7, title: 'Sad', body: 'Still waiting', rating: 1, productExternalId: '8891490140317', productTitle: 'Stwa X', productHandle: 'stwa-x', reviewerEmail: 'a@b.com', reviewerName: 'Ann', verified: 'buyer', hidden: false, createdAt: new Date('2026-11-08T10:00:00Z') })
  })
  it('listReviews throws JudgemeError with the status on 401', async () => {
    const f = fakeFetch(401, { error: 'Failed to authenticate' })
    const err = await new JudgemeClient({ token: 'bad', shopDomain: SHOP, fetch: f.fn }).listReviews({ rating: 1, page: 1, perPage: 1 }).catch(e => e)
    expect(err).toBeInstanceOf(JudgemeError)
    expect(err.status).toBe(401)
  })
  it('getReview returns null on 404', async () => {
    const f = fakeFetch(404, { error: 'not found' })
    expect(await new JudgemeClient({ token: 'tok', shopDomain: SHOP, fetch: f.fn }).getReview(9)).toBeNull()
  })
  it('getReview maps the review', async () => {
    const f = fakeFetch(200, { review: { ...raw, rating: 4 } })
    expect((await new JudgemeClient({ token: 'tok', shopDomain: SHOP, fetch: f.fn }).getReview(7))?.rating).toBe(4)
    expect(f.calls[0].url).toBe(`https://api.judge.me/api/v1/reviews/7?shop_domain=${SHOP}`)
  })
})
