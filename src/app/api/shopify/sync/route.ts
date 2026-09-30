import { NextRequest, NextResponse } from 'next/server'
import { PayoutSyncError, syncShopifyPayouts } from '@/lib/shopify-payouts-sync'

export async function POST(req: NextRequest) {
  try {
    const result = await syncShopifyPayouts({
      requestedDateMin: req.nextUrl.searchParams.get('date_min') ?? undefined,
      dateMax: req.nextUrl.searchParams.get('date_max') ?? undefined,
    })
    return NextResponse.json(result)
  } catch (err: any) {
    if (err instanceof PayoutSyncError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[sync]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
