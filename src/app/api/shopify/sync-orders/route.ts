import { NextResponse } from 'next/server'
import { syncShopifyOrders } from '@/lib/sync-shopify-orders'

export async function POST() {
  try {
    const result = await syncShopifyOrders()
    return NextResponse.json({ success: true, ...result })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
