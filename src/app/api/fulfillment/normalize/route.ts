import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { normalizeOpenOrderStatuses } from '@/lib/order-normalize'

// Manual trigger for the same normalization the daily cron runs.
export async function POST() {
  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) return connectionFailureResponse(error, { error: 'Not connected to Shopify.', status: 400 })
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) return NextResponse.json({ error: 'Connected store not found in DB.' }, { status: 404 })
  const result = await normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: store.id })
  return NextResponse.json(result)
}
