import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { logStoreFailures, okResults, saveJobResult } from '@/lib/store-jobs'
import { forEachParcelPanelStore, partitionByParcelPanelKey, syncParcelPanelForStore } from './parcelpanel-store-sync'

const TZ = 'Asia/Ho_Chi_Minh'

// Daily: refresh real carrier status from ParcelPanel for undelivered shipments, store by store, each under its own key.
export async function runDailyParcelPanelSync() {
  if ((await partitionByParcelPanelKey()).keyed.length === 0) {
    console.log('[parcelpanel] no connected store has a ParcelPanel API key (DB or env); skipping')
    return
  }
  const results = await forEachParcelPanelStore('parcelpanel-sync', (conn) => syncParcelPanelForStore(conn))
  logStoreFailures('parcelpanel', results.filter(r => r.ok || !r.skipped))
  try {
    await saveJobResult('last_parcelpanel_sync_result', results, {
      sum: ['ordersChecked', 'shipmentsUpdated', 'delivered'],
      concat: ['errors'],
    })
  } catch (e: any) {
    console.error('[parcelpanel] could not save the result:', e?.message ?? e)
  }
  for (const r of okResults(results)) {
    console.log(`[parcelpanel] ${r.shop}: ${r.result.shipmentsUpdated} shipments updated (${r.result.delivered} delivered) of ${r.result.ordersChecked} orders`)
    if (r.result.errors.length) console.error(`[parcelpanel] ${r.shop} errors:`, r.result.errors.slice(0, 5))
  }
}

export function initParcelPanelScheduler() {
  if (!initOnce('parcelpanel-scheduler')) return
  cron.schedule('0 4 * * *', () => {
    runExclusive('parcelpanel-sync', runDailyParcelPanelSync)
      .then(r => { if (r.skipped) console.warn('[parcelpanel] previous run still active; skipped') })
      .catch(err => console.error('[parcelpanel] unhandled:', err))
  }, { timezone: TZ })
  console.log('[parcelpanel] Initialized — daily ParcelPanel tracking sync at 04:00 Asia/Ho_Chi_Minh')
}
