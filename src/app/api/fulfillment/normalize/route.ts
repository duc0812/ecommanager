import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { normalizeOpenOrderStatuses } from '@/lib/order-normalize'

// Manual trigger for the same normalization the daily cron runs.
export async function POST() {
  const conn = await getShopifyConnection()
  if (!conn) return NextResponse.json({ error: 'Not connected to Shopify.' }, { status: 400 })
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return NextResponse.json({ error: 'Connected store not found in DB.' }, { status: 404 })
  const result = await normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: store.id })
  return NextResponse.json(result)
}
