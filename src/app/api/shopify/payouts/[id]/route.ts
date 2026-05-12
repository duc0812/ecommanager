import { NextRequest, NextResponse } from 'next/server'
import { fetchPayoutTransactions } from '@/lib/shopify'

// Fetch raw balance transactions của 1 payout để xem chi tiết
export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const transactions = await fetchPayoutTransactions(Number(params.id))

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
