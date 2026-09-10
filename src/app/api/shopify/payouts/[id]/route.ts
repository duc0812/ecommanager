import { NextRequest, NextResponse } from 'next/server'
import { fetchPayoutTransactions } from '@/lib/shopify'
import { getShopifyConnection } from '@/lib/token-store'

// Fetch raw balance transactions của 1 payout để xem chi tiết
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const stored = await getShopifyConnection()
    if (!stored) return NextResponse.json({ error: 'Not connected to Shopify. Go to /setup and connect Shopify first.' }, { status: 401 })
    const creds = { shop: stored.shop, token: stored.token }
    const transactions = await fetchPayoutTransactions(creds, Number(params.id))

    // Group theo type để dễ review
    const byType = transactions.reduce<Record<string, number>>((acc, t) => {
      acc[t.type] = (acc[t.type] ?? 0) + 1
      return acc
    }, {})

    const bySourceType = transactions.reduce<Record<string, number>>((acc, t) => {
      acc[t.source_type] = (acc[t.source_type] ?? 0) + 1
      return acc
    }, {})

    return NextResponse.json({ payout_id: params.id, total: transactions.length, byType, bySourceType, transactions })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
