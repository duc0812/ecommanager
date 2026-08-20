import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { runStoreProductScan } from './scan-runner'

let initialized = false

async function scanAllStores() {
  const stores = await prisma.spyStore.findMany({ where: { status: 'active' } })
  for (const s of stores) {
    try { await runStoreProductScan(s) }
    catch (e) { console.error('[spy-scheduler] scan failed for', s.domain, e) }
  }
  console.log(`[spy-scheduler] product scan done for ${stores.length} store(s)`)
}

export function initSpyScheduler() {
  if (initialized) return
  initialized = true
  cron.schedule('0 8,20 * * *', () => { scanAllStores().catch(e => console.error('[spy-scheduler]', e)) }, { timezone: 'Asia/Ho_Chi_Minh' })
  console.log('[spy-scheduler] Initialized — product scan at 08:00 & 20:00 Asia/Ho_Chi_Minh')
}
