import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { logStoreFailures, okResults, saveMergedJobResult } from '@/lib/store-jobs'
import { getSheets, getMinAgeDays } from './auto-fulfill-sheets'
import { runAutoFulfillForStores } from './auto-fulfill-stores'
import { syncPgprintsTracking } from '@/lib/repos/pgprints-push'
import { syncApiSupplierTracking } from '@/lib/repos/supplier-tracking-sync'

const TZ = 'Asia/Ho_Chi_Minh'

export async function runDailyAutoFulfill() {
  const sheets = (await getSheets()).filter(s => s.enabled)
  try {
    const pg = await syncPgprintsTracking()
    console.log(`[auto-fulfill] PGprints tracking sync: ${pg.found}/${pg.pushes} order(s) found, ${pg.shipments} shipment(s) updated${pg.skipped ? ` (${pg.skipped})` : ''}`)
  } catch (e: any) {
    console.error('[auto-fulfill] PGprints tracking sync failed:', e?.message ?? e)
  }
  for (const r of await syncApiSupplierTracking()) {
    if (r.error) console.error(`[auto-fulfill] ${r.name} tracking sync failed:`, r.error)
    else console.log(`[auto-fulfill] ${r.name} tracking sync: ${r.found}/${r.pushes} order(s) found, ${r.shipments} shipment(s) updated${r.skipped ? ` (${r.skipped})` : ''}`)
  }
  const minAgeDays = await getMinAgeDays()
  const { results, summary } = await runAutoFulfillForStores({ sheets, minAgeDays, apply: true })
  if (results.length === 0) console.error('[auto-fulfill] no connected store; skipping')
  logStoreFailures('auto-fulfill', results)
  try {
    await saveMergedJobResult('last_auto_fulfill_result', summary, results)
  } catch (e: any) {
    console.error('[auto-fulfill] could not save the result:', e?.message ?? e)
  }
  for (const r of okResults(results)) {
    console.log(`[auto-fulfill] ${r.shop}: fulfilled ${r.result.fulfilled}, tooRecent ${r.result.tooRecent}, needsManual ${r.result.needsManual}, errored ${r.result.errored} of ${r.result.ordersChecked}`)
  }
}

export function initAutoFulfillScheduler() {
  if (!initOnce('auto-fulfill-scheduler')) return
  cron.schedule('30 3 * * *', () => {
    runExclusive('auto-fulfill', runDailyAutoFulfill)
      .then(r => { if (r.skipped) console.warn('[auto-fulfill] previous run still active; skipped') })
      .catch(err => console.error('[auto-fulfill] unhandled:', err))
  }, { timezone: TZ })
  console.log('[auto-fulfill] Initialized — daily auto-fulfill at 03:30 Asia/Ho_Chi_Minh')
}
