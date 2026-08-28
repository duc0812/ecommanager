import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncStoreTracking, clampTrackingDays } from '@/lib/tracking/tracking-sync'

export async function POST(req: NextRequest) {
  const days = clampTrackingDays(req.nextUrl.searchParams.get('days'))

  const stored = await getShopifyConnection(req.headers.get('cookie') ?? undefined)
  const shop = req.headers.get('x-shopify-shop-domain') || stored?.shop
  const accessToken = req.headers.get('x-shopify-access-token') || stored?.token
  if (!shop || !accessToken) {
    return NextResponse.json({ error: 'Not connected to Shopify. Go to /setup and connect Shopify first.' }, { status: 401 })
  }

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
