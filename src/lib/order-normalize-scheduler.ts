import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { normalizeOpenOrderStatuses } from './order-normalize'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false

// Daily: pull the real fulfillment status for every OPEN order from Shopify and
// write back any changes, so old orders don't sit UNFULFILLED forever after
// Shopify has fulfilled them. Runs for the connected store (single-token app).
export async function runDailyOrderNormalize() {
  const conn = await getShopifyConnection()
  if (!conn) {
    console.log('[order-normalize] no Shopify connection stored; skipping')
    return
  }
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) {
    console.log(`[order-normalize] connected store ${conn.shop} not in DB; skipping`)
    return
  }
  try {
    const result = await normalizeOpenOrderStatuses({ shop: conn.shop, accessToken: conn.token, storeId: store.id })
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
  if (initialized) return
  initialized = true
  cron.schedule('0 2 * * *', () => {
    runDailyOrderNormalize().catch(err => console.error('[order-normalize] unhandled:', err))
  }, { timezone: TZ })
  console.log('[order-normalize] Initialized — daily status normalization at 02:00 Asia/Ho_Chi_Minh')
}
