import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { syncMetaInsights } from '@/lib/sync-meta-insights'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'

let initialized = false

function appBaseUrl() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  if (process.env.APP_URL) return process.env.APP_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}

async function syncOrdersViaOrderPlFlow() {
  const res = await fetch(`${appBaseUrl()}/api/shopify/orders/sync`, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Order sync failed with ${res.status}`)
  const refresh = await recalculateMissingOrderLineCosts()
  return { ...body, refresh }
}

export async function runAutoSync(): Promise<Record<string, any>> {
  const result: Record<string, any> = { startedAt: new Date().toISOString() }

  try {
    result.orders = await syncOrdersViaOrderPlFlow()
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

async function runNightlyMetaSync(): Promise<void> {
  console.log('[nightly-meta-sync] Starting previous-day finalization...')
  try {
    const result = await syncMetaInsights(2)
    await prisma.appSetting.upsert({
      where: { key: 'last_nightly_meta_sync' },
      create: { key: 'last_nightly_meta_sync', value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
      update: { value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
    })
    console.log(`[nightly-meta-sync] Done — synced ${result.synced} rows across ${result.accounts} accounts`)
    if (result.errors.length) console.error('[nightly-meta-sync] Errors:', result.errors)
  } catch (e: unknown) {
    console.error('[nightly-meta-sync] Fatal error:', e instanceof Error ? e.message : e)
  }
}

export function initAutoSync() {
  if (initialized) return
  initialized = true
  // 1am America/Denver (MDT = UTC-6 in summer, MST = UTC-7 in winter)
  cron.schedule('0 1 * * *', () => {
    runNightlyMetaSync().catch(err => console.error('[nightly-meta-sync] Unhandled error:', err))
  }, { timezone: 'America/Denver' })
  console.log('[auto-sync] Initialized — nightly Meta sync at 1:00am America/Denver')
}
