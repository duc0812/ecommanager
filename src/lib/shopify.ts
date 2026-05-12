const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!
const VERSION = process.env.SHOPIFY_API_VERSION ?? '2024-04'

const BASE = `https://${SHOP}/admin/api/${VERSION}`

const headers = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json',
}

// ─── Kiểu dữ liệu raw từ Shopify API ────────────────────────────────────────

export type ShopifyPayoutStatus = 'scheduled' | 'in_transit' | 'paid' | 'failed' | 'canceled'

export type ShopifyPayout = {
  id: number
  status: ShopifyPayoutStatus
  date: string           // "YYYY-MM-DD"
  currency: string       // "USD"
  amount: string         // "41.90"
  summary: {
    adjustments_fee_amount: string
    adjustments_gross_amount: string
    charges_fee_amount: string       // phí Shopify Payments
    charges_gross_amount: string     // tổng doanh thu từ orders
    refunds_fee_amount: string
    refunds_gross_amount: string
    reserved_funds_fee_amount: string
    reserved_funds_gross_amount: string
    retried_payouts_fee_amount: string
    retried_payouts_gross_amount: string
  }
}

export type ShopifyBalanceTransaction = {
  id: number
  type: string           // 'payout' | 'charge' | 'refund' | 'dispute' | 'adjustment' | 'credit' | ...
  test: boolean
  payout_id: number | null
  payout_status: ShopifyPayoutStatus | null
  currency: string
  amount: string
  fee: string
  net: string
  source_id: number
  source_type: string    // 'Order' | 'Refund' | 'Dispute' | ...
  source_order_id: number | null
  source_order_transaction_id: number | null
  processed_at: string   // ISO datetime
}

export type ShopifyBalance = {
  currency: string
  amount: string
}

// ─── API calls ───────────────────────────────────────────────────────────────

// Fetch tất cả payouts (tự động paginate qua Link header)
export async function fetchAllPayouts(params?: {
  since_id?: number
  last_id?: number
  date_min?: string   // "YYYY-MM-DD"
  date_max?: string
  limit?: number
}): Promise<ShopifyPayout[]> {
  const all: ShopifyPayout[] = []
  let url: string | null = buildUrl(`${BASE}/shopify_payments/payouts.json`, {
    limit: '250',
    ...(params?.since_id ? { since_id: String(params.since_id) } : {}),
    ...(params?.date_min ? { date_min: params.date_min } : {}),
    ...(params?.date_max ? { date_max: params.date_max } : {}),
  })

  while (url) {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Shopify payouts API error ${res.status}: ${text}`)
    }
    const data = await res.json()
    all.push(...(data.payouts ?? []))

    // Shopify dùng Link header để paginate
    const link = res.headers.get('link')
    url = parseNextLink(link)
  }

  return all
}

// Fetch balance transactions của 1 payout cụ thể
export async function fetchPayoutTransactions(payoutId: number): Promise<ShopifyBalanceTransaction[]> {
  const all: ShopifyBalanceTransaction[] = []
  let url: string | null = buildUrl(`${BASE}/shopify_payments/balance/transactions.json`, {
    payout_id: String(payoutId),
    limit: '250',
  })

  while (url) {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Shopify balance transactions API error ${res.status}: ${text}`)
    }
    const data = await res.json()
    all.push(...(data.transactions ?? []))
    url = parseNextLink(res.headers.get('link'))
  }

  return all
}

// Fetch current balance của store
export async function fetchBalance(): Promise<ShopifyBalance> {
  const res = await fetch(`${BASE}/shopify_payments/balance.json`, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify balance API error ${res.status}: ${text}`)
  }
  const data = await res.json()
  return data.balance
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base)
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
  return u.toString()
}

// Parse Link: <url>; rel="next" header từ Shopify
function parseNextLink(link: string | null): string | null {
  if (!link) return null
  const match = link.match(/<([^>]+)>;\s*rel="next"/)
  return match ? match[1] : null
}
