import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { syncStoreTracking } from './tracking-sync'

const TZ = 'Asia/Ho_Chi_Minh'

// Runs the tracking sync for the currently-connected Shopify store.
// NOTE: the app stores a single Shopify connection token (token-store is
// single-connection), so "all stores" today means the connected store. When
// per-store tokens exist, iterate stores here.
export async function runDailyTrackingSync() {
  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) {
    console.error(`[tracking-scheduler] ${error.message}; skipping`)
    return
  }
  try {
    const result = await syncStoreTracking({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId, days: 30 })
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
  if (!initOnce('tracking-scheduler')) return
  // Once daily at 03:00 Asia/Ho_Chi_Minh
  cron.schedule('0 3 * * *', () => {
    runExclusive('tracking-sync', runDailyTrackingSync)
      .then(r => { if (r.skipped) console.warn('[tracking-scheduler] previous run still active; skipped') })
      .catch(err => console.error('[tracking-scheduler] unhandled:', err))
  }, { timezone: TZ })
  console.log('[tracking-scheduler] Initialized — daily tracking sync at 03:00 Asia/Ho_Chi_Minh')
}
