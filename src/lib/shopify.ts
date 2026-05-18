// ─── Credentials ────────────────────────────────────────────────────────────
// Credentials được truyền từ UI vào (qua request headers ở API routes),
// không còn đọc từ process.env nữa.

export type ShopifyCredentials = {
  shop: string          // e.g. "your-store.myshopify.com"
  token: string         // Admin API access token
  version?: string      // API version, default "2024-04"
}

function buildBase(creds: ShopifyCredentials) {
  const version = creds.version || '2024-04'
  return {
    base: `https://${creds.shop}/admin/api/${version}`,
    headers: {
      'X-Shopify-Access-Token': creds.token,
      'Content-Type': 'application/json',
    } as Record<string, string>,
  }
}

function assertCreds(creds: ShopifyCredentials) {
  if (!creds?.shop || !creds?.token) {
    throw new Error('Missing Shopify credentials. Please fill in Shop domain and Access token in the UI.')
  }
}

// ─── Kiểu dữ liệu raw từ Shopify API ────────────────────────────────────────

export type ShopifyPayoutStatus = 'scheduled' | 'in_transit' | 'paid' | 'failed' | 'canceled'

export type ShopifyPayout = {
  id: number
  status: ShopifyPayoutStatus
  date: string           // "YYYY-MM-DD"
  currency: string       // "USD"
  amount: string         // "41.90"
  bank_account_id: number | null
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

export type ShopifyBankAccount = {
  id: number
  routing_number: string
  account_number: string   // masked, e.g. "****1234"
  bank_name: string
  country: string          // "US"
  currency: string         // "USD"
  verified: boolean
  verified_at: string | null
}

// ─── API calls ───────────────────────────────────────────────────────────────

// Fetch tất cả payouts (tự động paginate qua Link header)
export async function fetchAllPayouts(
  creds: ShopifyCredentials,
  params?: {
    since_id?: number
    last_id?: number
    date_min?: string   // "YYYY-MM-DD"
    date_max?: string
    limit?: number
  }
): Promise<ShopifyPayout[]> {
  assertCreds(creds)
  const { base, headers } = buildBase(creds)

  const all: ShopifyPayout[] = []
  let url: string | null = buildUrl(`${base}/shopify_payments/payouts.json`, {
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
export async function fetchPayoutTransactions(
  creds: ShopifyCredentials,
  payoutId: number
): Promise<ShopifyBalanceTransaction[]> {
  assertCreds(creds)
  const { base, headers } = buildBase(creds)

  const all: ShopifyBalanceTransaction[] = []
  let url: string | null = buildUrl(`${base}/shopify_payments/balance/transactions.json`, {
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
export async function fetchBalance(creds: ShopifyCredentials): Promise<ShopifyBalance> {
  assertCreds(creds)
  const { base, headers } = buildBase(creds)

  const res = await fetch(`${base}/shopify_payments/balance.json`, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify balance API error ${res.status}: ${text}`)
  }
  const data = await res.json()
  // Shopify returns balance as array: [{amount, currency}]
  const bal = Array.isArray(data.balance) ? data.balance[0] : data.balance
  return bal
}

// Fetch bank accounts via GraphQL Admin API (REST endpoint deprecated for some stores)
export async function fetchBankAccounts(creds: ShopifyCredentials, _bankAccountIds?: number[]): Promise<ShopifyBankAccount[]> {
  assertCreds(creds)
  const { base, headers } = buildBase(creds)

  const query = `{
    shopifyPaymentsAccount {
      bankAccounts(first: 10) {
        edges {
          node {
            id
            accountNumberLastDigits
            bankName
            country
            currency
            status
            createdAt
          }
        }
      }
    }
  }`

  const version = creds.version || '2024-04'
  const graphqlUrl = `https://${creds.shop}/admin/api/${version}/graphql.json`
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify GraphQL error ${res.status}: ${text}`)
  }

  const json = await res.json()
  console.log('[fetchBankAccounts GQL]', JSON.stringify(json).slice(0, 800))
  const edges = json?.data?.shopifyPaymentsAccount?.bankAccounts?.edges ?? []

  return edges.map((e: any) => ({
    id: e.node.id,
    routing_number: '',
    account_number: `****${e.node.accountNumberLastDigits ?? ''}`,
    bank_name: e.node.bankName ?? '',
    country: e.node.country ?? '',
    currency: e.node.currency ?? '',
    verified: ['VALIDATED', 'VERIFIED', 'verified', 'validated'].includes(e.node.status ?? ''),
    status: e.node.status ?? '',
    verified_at: null,
  }))
}

// ─── Helper: đọc credentials từ request headers ─────────────────────────────

export function getCredentialsFromRequest(req: Request): ShopifyCredentials {
  const shop = req.headers.get('x-shopify-shop-domain') || ''
  const token = req.headers.get('x-shopify-access-token') || ''
  const version = req.headers.get('x-shopify-api-version') || undefined
  return { shop, token, version }
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
