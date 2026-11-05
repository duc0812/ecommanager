import { NextRequest, NextResponse } from 'next/server'
import { fetchPayoutTransactions } from '@/lib/shopify'
import { prisma } from '@/lib/db'
import { getStoreConnection, getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { LITZZY_SHOP } from '@/lib/shopify-shop'

// Fetch raw balance transactions của 1 payout để xem chi tiết
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const payoutId = Number(params.id)
    // The payouts list is fetched live, so a payout can be opened before it was ever synced; that one belongs to Litzzy.
    const payout = Number.isInteger(payoutId) ? await prisma.payout.findUnique({ where: { id: payoutId }, select: { storeId: true } }) : null
    const { conn, error } = await tryStoreConnection(() => payout ? getStoreConnection(payout.storeId) : getStoreConnectionByShop(LITZZY_SHOP))
    if (!conn) return connectionFailureResponse(error, { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 })
    const creds = { shop: conn.shop, token: conn.token }
    const transactions = await fetchPayoutTransactions(creds, payoutId)

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
