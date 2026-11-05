import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { connectionFailureResponse } from '@/lib/store-connection-response'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { syncStoreTracking, clampTrackingDays } from '@/lib/tracking/tracking-sync'

export async function POST(req: NextRequest) {
  const days = clampTrackingDays(req.nextUrl.searchParams.get('days'))

  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) return connectionFailureResponse(error, { error: 'Not connected to Shopify. Go to /setup and connect Shopify first.', status: 401 })
  const { shop, token: accessToken } = conn

  const store = await prisma.shopifyStore.findUnique({ where: { shop }, include: { project: true } })
  if (!store) {
    return NextResponse.json({ error: 'Store not found in DB. Connect via /setup first.' }, { status: 404 })
  }
  if (!store.projectId || !store.project) {
    return NextResponse.json({ error: 'Store not linked to a project. Assign it in /setup/projects.' }, { status: 400 })
  }

  const result = await syncStoreTracking({ shop, accessToken, storeId: store.id, days })

  if (result.errors.length > 0 && result.shipmentCount === 0) {
    return NextResponse.json({ error: result.errors[0], ...result }, { status: 502 })
  }

  return NextResponse.json({ ...result, projectName: store.project.name })
}
