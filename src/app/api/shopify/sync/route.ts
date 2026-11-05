import { NextRequest, NextResponse } from 'next/server'
import { PayoutSyncError, syncPayoutsForConnectedStores } from '@/lib/shopify-payouts-sync'
import { storeRunsResponse } from '@/lib/store-run-response'

export async function POST(req: NextRequest) {
  try {
    const { results } = await syncPayoutsForConnectedStores({
      requestedDateMin: req.nextUrl.searchParams.get('date_min') ?? undefined,
      dateMax: req.nextUrl.searchParams.get('date_max') ?? undefined,
    })
    return storeRunsResponse(results, { sum: ['synced_payouts', 'synced_bank_accounts'] }, {
      notConnected: { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 },
    })
  } catch (err: any) {
    if (err instanceof PayoutSyncError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[sync]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
