import cron, { type ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from './scan-runner'
import { runPageAdScan } from './scan-ads'
import { parseCronConfig, cronExpr, SPY_CRON_CONFIG_KEY, type SpyCronConfig } from './cron-config'
import { initOnce, runExclusive } from '@/lib/job-lock'

const TZ = 'Asia/Ho_Chi_Minh'
const OBSERVATION_RETENTION_DAYS = 120

// Task handles live on globalThis: Next.js bundles this module into several chunks
// (instrumentation + route handlers), and reloadSpyScheduler() must stop the tasks
// the boot-time copy registered, not a private empty list.
type SchedulerState = { tasks: ScheduledTask[] }
const g = globalThis as typeof globalThis & { __spyScheduler?: SchedulerState }
function state(): SchedulerState {
  if (!g.__spyScheduler) g.__spyScheduler = { tasks: [] }
  return g.__spyScheduler
}

async function sweepStaleScans() {
  const result = await prisma.spyScan.updateMany({
    where: { status: 'running' },
    data: { status: 'failed', error: 'Interrupted by process restart', finishedAt: new Date() },
  })
  if (result.count > 0) console.log(`[spy-scheduler] swept ${result.count} stale running scan(s) to failed`)
}

// Per-ad summary columns (firstCollationCount / everActive / observationCount) carry
// the signals, so old observation rows can be dropped without losing them.
export async function pruneOldObservations(retentionDays = OBSERVATION_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const result = await prisma.spyAdObservation.deleteMany({ where: { observedAt: { lt: cutoff } } })
  if (result.count > 0) console.log(`[spy-scheduler] pruned ${result.count} observation(s) older than ${retentionDays}d`)
  return result.count
}

async function scanAllStores() {
  const outcome = await runExclusive('spy:store-scan', async () => {
    const stores = await prisma.spyStore.findMany({ where: { status: 'active' } })
    for (const s of stores) {
      try { await runStoreProductScan(s) }
      catch (e) { console.error('[spy-scheduler] scan failed for', s.domain, e) }
      try { await runStoreBestSellerScan(s) }
      catch (e) { console.error('[spy-scheduler] best-seller scan failed for', s.domain, e) }
    }
    console.log(`[spy-scheduler] product + best-seller scan done for ${stores.length} store(s)`)
  })
  if (outcome.skipped) console.warn('[spy-scheduler] store scan still running from previous tick; skipped')
}

export async function scanAllPageTargets() {
  const outcome = await runExclusive('spy:ad-scan', async () => {
    const targets = await prisma.spyPageTarget.findMany({ where: { active: true, excluded: false } })
    for (const t of targets) {
      try { await runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl, adDomainId: t.adDomainId }) }
      catch (e) { console.error('[spy-scheduler] ad scan failed for', t.pageUrl, e) }
    }
    await pruneOldObservations().catch(e => console.error('[spy-scheduler] prune failed', e))
    console.log(`[spy-scheduler] ad scan done for ${targets.length} page target(s)`)
  })
  if (outcome.skipped) console.warn('[spy-scheduler] ad scan still running from previous tick; skipped')
}

async function loadConfig(): Promise<SpyCronConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_CRON_CONFIG_KEY } })
  return parseCronConfig(row?.value)
}

function applySchedule(cfg: SpyCronConfig) {
  const s = state()
  s.tasks.forEach(t => { t.stop(); t.destroy?.() })
  s.tasks = []
  if (cfg.productBestSeller.enabled) {
    const e = cronExpr(cfg.productBestSeller.hours)
    if (e) s.tasks.push(cron.schedule(e, () => { scanAllStores().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  if (cfg.ads.enabled) {
    const e = cronExpr(cfg.ads.hours)
    if (e) s.tasks.push(cron.schedule(e, () => { scanAllPageTargets().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  console.log(`[spy-scheduler] applied ${s.tasks.length} task(s) (tz ${TZ})`)
}

export async function reloadSpyScheduler() {
  applySchedule(await loadConfig())
}

export function initSpyScheduler() {
  if (!initOnce('spy-scheduler')) return
  sweepStaleScans().catch(e => console.error('[spy-scheduler]', e))
  pruneOldObservations().catch(e => console.error('[spy-scheduler]', e))
  reloadSpyScheduler().catch(e => console.error('[spy-scheduler]', e))
  console.log('[spy-scheduler] Initialized (config-driven)')
}
