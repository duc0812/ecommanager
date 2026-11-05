import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { forEachConnectedStore, logStoreFailures, okResults, saveJobResult } from '@/lib/store-jobs'
import { normalizeOpenOrderStatuses } from './order-normalize'

const TZ = 'Asia/Ho_Chi_Minh'

// Daily: pull the real fulfillment status for every OPEN order from Shopify and
// write back any changes, so old orders don't sit UNFULFILLED forever after
// Shopify has fulfilled them. Runs for every connected store, one after the other.
export async function runDailyOrderNormalize() {
  const results = await forEachConnectedStore('order-normalize', (conn) =>
    normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId }))
  if (results.length === 0) console.error('[order-normalize] no connected store; skipping')
  logStoreFailures('order-normalize', results)
  try {
    await saveJobResult('last_order_normalize_result', results, {
      sum: ['ordersOpen', 'fulfillmentUpdated', 'pipelineFulfilled'],
      concat: ['errors'],
    })
  } catch (e: any) {
    console.error('[order-normalize] could not save the result:', e?.message ?? e)
  }
  for (const r of okResults(results)) {
    console.log(`[order-normalize] ${r.shop}: ${r.result.fulfillmentUpdated} fulfillment, ${r.result.pipelineFulfilled} pipeline→FULFILLED (of ${r.result.ordersOpen} open)`)
    if (r.result.errors.length) console.error(`[order-normalize] ${r.shop} errors:`, r.result.errors.slice(0, 5))
  }
}

export function initOrderNormalizeScheduler() {
  if (!initOnce('order-normalize-scheduler')) return
  cron.schedule('0 2 * * *', () => {
    runExclusive('order-normalize', runDailyOrderNormalize)
      .then(r => { if (r.skipped) console.warn('[order-normalize] previous run still active; skipped') })
      .catch(err => console.error('[order-normalize] unhandled:', err))
  }, { timezone: TZ })
  console.log('[order-normalize] Initialized — daily status normalization at 02:00 Asia/Ho_Chi_Minh')
}
