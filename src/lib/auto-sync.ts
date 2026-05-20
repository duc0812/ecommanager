import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { syncShopifyOrders } from '@/lib/sync-shopify-orders'
import { syncMetaInsights } from '@/lib/sync-meta-insights'

let initialized = false

export async function runAutoSync(): Promise<Record<string, any>> {
  const result: Record<string, any> = { startedAt: new Date().toISOString() }

  try {
    result.orders = await syncShopifyOrders()
  } catch (e: unknown) {
    result.orders = { error: e instanceof Error ? e.message : 'Unknown error' }
  }

  try {
    result.insights = await syncMetaInsights()
  } catch (e: unknown) {
    result.insights = { error: e instanceof Error ? e.message : 'Unknown error' }
  }

  result.finishedAt = new Date().toISOString()

  await prisma.appSetting.upsert({
    where: { key: 'last_auto_sync_result' },
    create: { key: 'last_auto_sync_result', value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  })

  return result
}

export function initAutoSync() {
  if (initialized) return
  initialized = true
  cron.schedule('0 * * * *', () => {
    runAutoSync().catch(err => console.error('[auto-sync] Error:', err))
  })
  console.log('[auto-sync] Initialized — runs every hour on the hour')
}
