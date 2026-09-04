import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncParcelPanelTracking } from '@/lib/tracking/parcelpanel-sync'
import { getParcelPanelApiKey } from '@/lib/tracking/parcelpanel-config'

// Manual trigger for the ParcelPanel tracking status sync (same as the daily cron).
export async function POST() {
  const apiKey = await getParcelPanelApiKey()
  if (!apiKey) return NextResponse.json({ error: 'Chưa cấu hình ParcelPanel API key. Nhập key ở nút cấu hình trên trang Tracking.' }, { status: 400 })
  const conn = await getShopifyConnection()
  const store = conn ? await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } }) : null
  const result = await syncParcelPanelTracking({ apiKey, storeId: store?.id })
  return NextResponse.json(result)
}
