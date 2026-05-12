import { NextRequest, NextResponse } from 'next/server'
import { fetchAllPayouts, fetchBalance } from '@/lib/shopify'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date_min = searchParams.get('date_min') ?? undefined
  const date_max = searchParams.get('date_max') ?? undefined

  try {
    const [payouts, balance] = await Promise.all([
      fetchAllPayouts({ date_min, date_max }),
      fetchBalance(),
    ])

    // Trả về raw data + một số stats để dễ review
    const stats = {
      total_payouts: payouts.length,
      total_paid: payouts.filter(p => p.status === 'paid').length,
      total_amount_paid: payouts
        .filter(p => p.status === 'paid')
        .reduce((sum, p) => sum + parseFloat(p.amount), 0)
        .toFixed(2),
      currency: payouts[0]?.currency ?? balance.currency,
      date_range: payouts.length
        ? { from: payouts.at(-1)?.date, to: payouts[0]?.date }
        : null,
    }

    return NextResponse.json({ stats, balance, payouts })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
