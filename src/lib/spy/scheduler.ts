import cron, { type ScheduledTask } from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan, runStoreBestSellerScan } from './scan-runner'
import { runPageAdScan } from './scan-ads'
import { parseCronConfig, cronExpr, SPY_CRON_CONFIG_KEY, type SpyCronConfig } from './cron-config'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false
let tasks: ScheduledTask[] = []

async function sweepStaleScans() {
  const result = await prisma.spyScan.updateMany({
    where: { status: 'running' },
    data: { status: 'failed', error: 'Interrupted by process restart', finishedAt: new Date() },
  })
  if (result.count > 0) console.log(`[spy-scheduler] swept ${result.count} stale running scan(s) to failed`)
}

async function scanAllStores() {
  const stores = await prisma.spyStore.findMany({ where: { status: 'active' } })
  for (const s of stores) {
    try { await runStoreProductScan(s) }
    catch (e) { console.error('[spy-scheduler] scan failed for', s.domain, e) }
    try { await runStoreBestSellerScan(s) }
    catch (e) { console.error('[spy-scheduler] best-seller scan failed for', s.domain, e) }
  }
  console.log(`[spy-scheduler] product + best-seller scan done for ${stores.length} store(s)`)
}

async function scanAllPageTargets() {
  const targets = await prisma.spyPageTarget.findMany({ where: { active: true } })
  for (const t of targets) {
    try { await runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl }) }
    catch (e) { console.error('[spy-scheduler] ad scan failed for', t.pageUrl, e) }
  }
  console.log(`[spy-scheduler] ad scan done for ${targets.length} page target(s)`)
}

async function loadConfig(): Promise<SpyCronConfig> {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_CRON_CONFIG_KEY } })
  return parseCronConfig(row?.value)
}

function applySchedule(cfg: SpyCronConfig) {
  tasks.forEach(t => t.stop())
  tasks = []
  if (cfg.productBestSeller.enabled) {
    const e = cronExpr(cfg.productBestSeller.hours)
    if (e) tasks.push(cron.schedule(e, () => { scanAllStores().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  if (cfg.ads.enabled) {
    const e = cronExpr(cfg.ads.hours)
    if (e) tasks.push(cron.schedule(e, () => { scanAllPageTargets().catch(err => console.error('[spy-scheduler]', err)) }, { timezone: TZ }))
  }
  console.log(`[spy-scheduler] applied ${tasks.length} task(s) (tz ${TZ})`)
}

export async function reloadSpyScheduler() {
  applySchedule(await loadConfig())
}

export function initSpyScheduler() {
  if (initialized) return
  initialized = true
  sweepStaleScans().catch(e => console.error('[spy-scheduler]', e))
  reloadSpyScheduler().catch(e => console.error('[spy-scheduler]', e))
  console.log('[spy-scheduler] Initialized (config-driven)')
}
