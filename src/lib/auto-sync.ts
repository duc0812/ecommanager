import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { prisma } from '@/lib/db'
import { syncMetaInsights, syncMetaCampaignInsights, type SyncMetaInsightsResult } from '@/lib/sync-meta-insights'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'


export const LAST_AUTO_SYNC_KEY = 'last_auto_sync_result'

// A run limited to some stores keeps its own last result, so it never replaces (or shows) the all-store run.
export type AutoSyncScope = { storeIds: string[]; accountIds: string[] }

export function autoSyncResultKey(storeIds: string[] | null) {
  return storeIds ? `${LAST_AUTO_SYNC_KEY}:${[...storeIds].sort().join(',')}` : LAST_AUTO_SYNC_KEY
}

function appBaseUrl(requestOrigin?: string) {
  if (requestOrigin) return requestOrigin.replace(/\/$/, '')
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
  if (process.env.APP_URL) return process.env.APP_URL
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'http://localhost:3000'
}

async function syncOrdersViaOrderPlFlow(requestOrigin?: string, cookieHeader?: string | null) {
  const res = await fetch(`${appBaseUrl(requestOrigin)}/api/shopify/orders/sync`, {
    method: 'POST',
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    redirect: 'manual',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Order sync failed with ${res.status}`)
  if (typeof body.totalSynced !== 'number') {
    throw new Error('Order sync returned an invalid response. Check app URL and authentication.')
  }
  const refresh = await recalculateMissingOrderLineCosts()
  return { ...body, refresh }
}

// The order sync one store at a time through the same route, so its store handling and lock apply. Stores that
// fail are listed in errors; only when none got through is the whole step an error.
async function syncStoreOrdersViaOrderPlFlow(storeIds: string[], requestOrigin?: string, cookieHeader?: string | null) {
  const counted: Array<Record<string, any>> = []
  const errors: string[] = []
  for (const storeId of storeIds) {
    try {
      const res = await fetch(`${appBaseUrl(requestOrigin)}/api/shopify/orders/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        body: JSON.stringify({ storeId }),
        redirect: 'manual',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `Order sync failed with ${res.status}`)
      if (typeof body.totalSynced !== 'number') throw new Error('Order sync returned an invalid response. Check app URL and authentication.')
      counted.push(body)
    } catch (e: unknown) {
      errors.push(e instanceof Error ? e.message : 'Unknown error')
    }
  }
  if (counted.length === 0 && errors.length > 0) throw new Error(errors[0])
  const refresh = counted.length > 0 ? await recalculateMissingOrderLineCosts({ storeIds }) : null
  return {
    totalSynced: counted.reduce((total, b) => total + b.totalSynced, 0),
    withUnmappedSku: counted.reduce((total, b) => total + (Number(b.withUnmappedSku) || 0), 0),
    errors: [...counted.flatMap(b => (Array.isArray(b.errors) ? b.errors : [])), ...errors],
    stores: counted.flatMap(b => (Array.isArray(b.stores) ? b.stores : [])),
    refresh,
  }
}

async function syncAccountInsights(
  sync: (options: { accountId: string }) => Promise<SyncMetaInsightsResult>,
  accountIds: string[],
): Promise<SyncMetaInsightsResult> {
  const parts: SyncMetaInsightsResult[] = []
  for (const accountId of accountIds) parts.push(await sync({ accountId }))
  const ranges = parts.map(p => p.range).filter(r => r.since && r.until)
  return {
    synced: parts.reduce((total, p) => total + p.synced, 0),
    accounts: parts.reduce((total, p) => total + p.accounts, 0),
    errors: Array.from(new Set(parts.flatMap(p => p.errors))),
    perAccount: parts.flatMap(p => p.perAccount),
    range: ranges.length > 0
      ? { since: ranges.map(r => r.since).sort()[0], until: ranges.map(r => r.until).sort().reverse()[0] }
      : { since: '', until: '' },
  }
}

export async function runAutoSync(requestOrigin?: string, cookieHeader?: string | null, scope: AutoSyncScope | null = null): Promise<Record<string, any>> {
  const outcome = await runExclusive('auto-sync', () => runAutoSyncInner(requestOrigin, cookieHeader, scope))
  if (outcome.skipped) return { skipped: true, error: 'Auto sync is already running' }
  return outcome.result
}

async function runAutoSyncInner(requestOrigin: string | undefined, cookieHeader: string | null | undefined, scope: AutoSyncScope | null): Promise<Record<string, any>> {
  const result: Record<string, any> = { startedAt: new Date().toISOString() }

  try {
    result.orders = scope
      ? await syncStoreOrdersViaOrderPlFlow(scope.storeIds, requestOrigin, cookieHeader)
      : await syncOrdersViaOrderPlFlow(requestOrigin, cookieHeader)
  } catch (e: unknown) {
    result.orders = { error: e instanceof Error ? e.message : 'Unknown error' }
  }

  try {
    result.insights = scope ? await syncAccountInsights(syncMetaInsights, scope.accountIds) : await syncMetaInsights()
  } catch (e: unknown) {
    result.insights = { error: e instanceof Error ? e.message : 'Unknown error' }
  }

  try {
    result.campaignInsights = scope ? await syncAccountInsights(syncMetaCampaignInsights, scope.accountIds) : await syncMetaCampaignInsights()
  } catch (e: unknown) {
    result.campaignInsights = { error: e instanceof Error ? e.message : 'Unknown error' }
  }

  result.finishedAt = new Date().toISOString()

  const key = autoSyncResultKey(scope ? scope.storeIds : null)
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  })

  return result
}

async function runNightlyMetaSync(): Promise<void> {
  console.log('[nightly-meta-sync] Starting previous-day finalization...')
  try {
    const result = await syncMetaInsights(2)

    let campaigns: Awaited<ReturnType<typeof syncMetaCampaignInsights>> | { error: string }
    try {
      campaigns = await syncMetaCampaignInsights(2)
    } catch (e: unknown) {
      campaigns = { error: e instanceof Error ? e.message : 'Unknown error' }
    }

    const payload = { ...result, campaigns, ranAt: new Date().toISOString() }
    await prisma.appSetting.upsert({
      where: { key: 'last_nightly_meta_sync' },
      create: { key: 'last_nightly_meta_sync', value: JSON.stringify(payload) },
      update: { value: JSON.stringify(payload) },
    })
    const campaignSynced = 'synced' in campaigns ? campaigns.synced : 0
    console.log(`[nightly-meta-sync] Done — synced ${result.synced} account rows, ${campaignSynced} campaign rows across ${result.accounts} accounts`)
    if (result.errors.length) console.error('[nightly-meta-sync] Errors:', result.errors)
    if ('error' in campaigns) {
      console.error('[nightly-meta-sync] Campaign sync failed:', campaigns.error)
    } else if (campaigns.errors.length) {
      console.error('[nightly-meta-sync] Campaign errors:', campaigns.errors)
    }
  } catch (e: unknown) {
    console.error('[nightly-meta-sync] Fatal error:', e instanceof Error ? e.message : e)
  }
}

export function initAutoSync() {
  if (!initOnce('auto-sync')) return
  // 1am America/Denver (MDT = UTC-6 in summer, MST = UTC-7 in winter)
  cron.schedule('0 1 * * *', () => {
    runExclusive('nightly-meta-sync', runNightlyMetaSync)
      .then(r => { if (r.skipped) console.warn('[nightly-meta-sync] previous run still active; skipped') })
      .catch(err => console.error('[nightly-meta-sync] Unhandled error:', err))
  }, { timezone: 'America/Denver' })
  console.log('[auto-sync] Initialized — nightly Meta sync at 1:00am America/Denver')
}
