import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncStoreTracking } from './tracking-sync'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false

// Runs the tracking sync for the currently-connected Shopify store.
// NOTE: the app stores a single Shopify connection token (token-store is
// single-connection), so "all stores" today means the connected store. When
// per-store tokens exist, iterate stores here.
export async function runDailyTrackingSync() {
  const conn = await getShopifyConnection()
  if (!conn) {
    console.log('[tracking-scheduler] no Shopify connection stored; skipping')
    return
  }
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) {
    console.log(`[tracking-scheduler] connected store ${conn.shop} not in DB; skipping`)
    return
  }
  try {
    const result = await syncStoreTracking({ shop: conn.shop, accessToken: conn.token, storeId: store.id, days: 30 })
    await prisma.appSetting.upsert({
      where: { key: 'last_tracking_sync_result' },
      create: { key: 'last_tracking_sync_result', value: JSON.stringify({ ...result, shop: conn.shop, ranAt: new Date().toISOString() }) },
      update: { value: JSON.stringify({ ...result, shop: conn.shop, ranAt: new Date().toISOString() }) },
    })
    console.log(`[tracking-scheduler] ${conn.shop}: ${result.shipmentCount} shipments, ${result.fulfillmentStatusUpdated} status updates`)
  } catch (e: any) {
    console.error('[tracking-scheduler] failed:', e?.message ?? e)
  }
  // Delivery-status crawling removed — ParcelPanel on the store handles customer-facing status.
}

export function initTrackingScheduler() {
  if (initialized) return
  initialized = true
  // Once daily at 03:00 Asia/Ho_Chi_Minh
  cron.schedule('0 3 * * *', () => {
    runDailyTrackingSync().catch(err => console.error('[tracking-scheduler] unhandled:', err))
  }, { timezone: TZ })
  console.log('[tracking-scheduler] Initialized — daily tracking sync at 03:00 Asia/Ho_Chi_Minh')
}
