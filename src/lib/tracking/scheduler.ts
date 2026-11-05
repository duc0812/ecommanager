import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { forEachConnectedStore, logStoreFailures, okResults, saveJobResult } from '@/lib/store-jobs'
import { syncStoreTracking } from './tracking-sync'

const TZ = 'Asia/Ho_Chi_Minh'

// Runs the tracking sync for every connected store, one after the other; a store that fails is
// recorded on that store and does not stop the next one.
export async function runDailyTrackingSync() {
  const results = await forEachConnectedStore('tracking-sync', (conn) =>
    syncStoreTracking({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId, days: 30 }))
  if (results.length === 0) console.error('[tracking-scheduler] no connected store; skipping')
  logStoreFailures('tracking-scheduler', results)
  try {
    await saveJobResult('last_tracking_sync_result', results, {
      sum: ['ordersProcessed', 'shipmentCount', 'withTracking', 'withoutTracking', 'fulfillmentStatusUpdated'],
      concat: ['errors'],
    })
  } catch (e: any) {
    console.error('[tracking-scheduler] could not save the result:', e?.message ?? e)
  }
  for (const r of okResults(results)) {
    console.log(`[tracking-scheduler] ${r.shop}: ${r.result.shipmentCount} shipments, ${r.result.fulfillmentStatusUpdated} status updates`)
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
