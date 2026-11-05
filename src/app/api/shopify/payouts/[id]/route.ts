import { NextRequest, NextResponse } from 'next/server'
import { fetchPayoutTransactions } from '@/lib/shopify'
import { prisma } from '@/lib/db'
import { getStoreConnection, listConnectedStores, tryStoreConnection } from '@/lib/store-connections'
import { firstStoreOf } from '@/lib/finance-scope'
import { requireStoreFilter, storeScopeFor } from '@/lib/store-scope'
import { connectionFailureResponse } from '@/lib/store-connection-response'

// A caller who does not see every store gets the same 404 for a payout of another store and for an id that is no payout,
// so the answer does not say which payout ids exist elsewhere.
const payoutNotFound = () => NextResponse.json({ error: 'Không tìm thấy payout' }, { status: 404 })

// Fetch raw balance transactions của 1 payout để xem chi tiết
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireStoreFilter(req, 'shopify')
  if ('error' in scope) return scope.error
  try {
    const payoutId = Number(params.id)
    // The payouts list is fetched live, so a payout can be opened before it was ever synced; that one
    // belongs to the store named by ?storeId, else the first connected store.
    const payout = Number.isInteger(payoutId) ? await prisma.payout.findUnique({ where: { id: payoutId }, select: { storeId: true } }) : null
    const notConnected = { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 }
    const seen = await storeScopeFor(scope.user)
    if (payout && !seen.all && !seen.storeIds.includes(payout.storeId)) return payoutNotFound()
    const named = req.nextUrl.searchParams.get('storeId')
    const storeId = payout?.storeId
      ?? (named && named !== 'all' ? named : null)
      ?? firstStoreOf(await listConnectedStores(), scope.storeIds)?.id
    if (!storeId) return seen.all ? NextResponse.json({ error: notConnected.error }, { status: notConnected.status }) : payoutNotFound()
    const { conn, error } = await tryStoreConnection(() => getStoreConnection(storeId))
    if (!conn) return connectionFailureResponse(error, notConnected)
    const creds = { shop: conn.shop, token: conn.token }
    const transactions = await fetchPayoutTransactions(creds, payoutId)
    // Opened before it was ever synced: a payout that does not exist in the caller's store has no transactions at all.
    if (!payout && !seen.all && transactions.length === 0) return payoutNotFound()

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
