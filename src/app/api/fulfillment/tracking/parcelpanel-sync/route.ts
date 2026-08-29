import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncParcelPanelTracking } from '@/lib/tracking/parcelpanel-sync'

// Manual trigger for the ParcelPanel tracking status sync (same as the daily cron).
export async function POST() {
  const apiKey = process.env.PARCELPANEL_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'PARCELPANEL_API_KEY chưa cấu hình trên server.' }, { status: 400 })
  const conn = await getShopifyConnection()
  const store = conn ? await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } }) : null
  const result = await syncParcelPanelTracking({ apiKey, storeId: store?.id })
  return NextResponse.json(result)
}
