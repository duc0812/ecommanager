import { NextRequest, NextResponse } from 'next/server'
import { getShopifyConnection } from '@/lib/token-store'

export async function GET(req: NextRequest) {
  const stored = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  if (!stored) return NextResponse.json({ error: 'Not connected' }, { status: 401 })

  const version = '2024-04'
  const base = `https://${stored.shop}/admin/api/${version}`
  const headers: Record<string, string> = {
    'X-Shopify-Access-Token': stored.token,
    'Content-Type': 'application/json',
  }

  // 1. Balance REST endpoint
  const balanceRes = await fetch(`${base}/shopify_payments/balance.json`, { headers })
  const balanceData = { status: balanceRes.status, body: await balanceRes.json() }

  // 2. GraphQL bank accounts
  const gqlRes = await fetch(`https://${stored.shop}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: `{
        __type(name: "ShopifyPaymentsAccount") { fields { name type { name kind } } }
        shopifyPaymentsAccount {
          id
        }
      }`
    }),
  })
  const gqlData = await gqlRes.json()

  return NextResponse.json({
    balance_rest: balanceData,
    graphql_status: gqlRes.status,
    graphql_response: gqlData,
  })
}
