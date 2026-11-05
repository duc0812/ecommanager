import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { normalizeOpenOrderStatuses } from './order-normalize'

const TZ = 'Asia/Ho_Chi_Minh'

// Daily: pull the real fulfillment status for every OPEN order from Shopify and
// write back any changes, so old orders don't sit UNFULFILLED forever after
// Shopify has fulfilled them. Runs for the connected store (single-token app).
export async function runDailyOrderNormalize() {
  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) {
    console.error(`[order-normalize] ${error.message}; skipping`)
    return
  }
  try {
    const result = await normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId })
    await prisma.appSetting.upsert({
      where: { key: 'last_order_normalize_result' },
      create: { key: 'last_order_normalize_result', value: JSON.stringify({ ...result, shop: conn.shop, ranAt: new Date().toISOString() }) },
      update: { value: JSON.stringify({ ...result, shop: conn.shop, ranAt: new Date().toISOString() }) },
    })
    console.log(`[order-normalize] ${conn.shop}: ${result.fulfillmentUpdated} fulfillment, ${result.pipelineFulfilled} pipeline→FULFILLED (of ${result.ordersOpen} open)`)
    if (result.errors.length) console.error('[order-normalize] errors:', result.errors.slice(0, 5))
  } catch (e: any) {
    console.error('[order-normalize] failed:', e?.message ?? e)
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
