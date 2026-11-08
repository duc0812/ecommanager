// Judge.me private API (https://judge.me/api/docs): token in X-Api-Token, shop in shop_domain.
const BASE = 'https://api.judge.me/api/v1'

export type JmReview = {
  id: number
  title: string | null
  body: string
  rating: number
  productExternalId: string | null
  productTitle: string | null
  productHandle: string | null
  reviewerEmail: string | null
  reviewerName: string | null
  verified: string | null
  hidden: boolean
  createdAt: Date
}

export class JudgemeError extends Error {
  constructor(public status: number, message: string) {
    super(`Judge.me ${status}: ${message}`)
  }
}

function mapReview(r: any): JmReview {
  return {
    id: Number(r.id),
    title: r.title ?? null,
    body: r.body ?? '',
    rating: Number(r.rating),
    productExternalId: r.product_external_id != null ? String(r.product_external_id) : null,
    productTitle: r.product_title ?? null,
    productHandle: r.product_handle ?? null,
    reviewerEmail: r.reviewer?.email ? String(r.reviewer.email).trim().toLowerCase() : null,
    reviewerName: r.reviewer?.name ?? null,
    verified: r.verified ?? null,
    hidden: r.hidden === true,
    createdAt: new Date(r.created_at),
  }
}

export class JudgemeClient {
  private fetchFn: typeof fetch
  constructor(private o: { token: string; shopDomain: string; fetch?: typeof fetch }) {
    this.fetchFn = o.fetch ?? fetch
  }

  private async call(path: string, query: Record<string, string | number> = {}): Promise<{ status: number; json: any }> {
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), shop_domain: this.o.shopDomain })
    const res = await this.fetchFn(`${BASE}${path}?${q.toString()}`, { headers: { 'X-Api-Token': this.o.token, Accept: 'application/json' } })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  async listReviews(o: { rating: number; page: number; perPage: number }): Promise<JmReview[]> {
    const { status, json } = await this.call('/reviews', { rating: o.rating, per_page: o.perPage, page: o.page })
    if (status !== 200) throw new JudgemeError(status, String(json?.error ?? json?.message ?? 'request failed').slice(0, 200))
    return (json.reviews ?? []).map(mapReview)
  }

  async getReview(id: number): Promise<JmReview | null> {
    const { status, json } = await this.call(`/reviews/${id}`)
    if (status === 404) return null
    if (status !== 200) throw new JudgemeError(status, String(json?.error ?? 'request failed').slice(0, 200))
    return json.review ? mapReview(json.review) : null
  }
}
