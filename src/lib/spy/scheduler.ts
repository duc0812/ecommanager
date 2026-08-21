import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan } from './scan-runner'
import { runPageAdScan } from './scan-ads'

let initialized = false

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
  }
  console.log(`[spy-scheduler] product scan done for ${stores.length} store(s)`)
}

async function scanAllPageTargets() {
  const targets = await prisma.spyPageTarget.findMany({ where: { active: true } })
  for (const t of targets) {
    try { await runPageAdScan({ id: t.id, storeId: t.storeId, pageUrl: t.pageUrl }) }
    catch (e) { console.error('[spy-scheduler] ad scan failed for', t.pageUrl, e) }
  }
  console.log(`[spy-scheduler] ad scan done for ${targets.length} page target(s)`)
}

export function initSpyScheduler() {
  if (initialized) return
  initialized = true
  sweepStaleScans().catch(e => console.error('[spy-scheduler]', e))
  cron.schedule('0 8,20 * * *', () => { scanAllStores().catch(e => console.error('[spy-scheduler]', e)) }, { timezone: 'Asia/Ho_Chi_Minh' })
  cron.schedule('0 9 * * *', () => { scanAllPageTargets().catch(e => console.error('[spy-scheduler]', e)) }, { timezone: 'Asia/Ho_Chi_Minh' })
  console.log('[spy-scheduler] Initialized — product scan at 08:00 & 20:00, ad scan at 09:00 Asia/Ho_Chi_Minh')
}
