import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { prisma } from '@/lib/db'
import { getStoreConnectionByShop, tryStoreConnection } from '@/lib/store-connections'
import { LITZZY_SHOP } from '@/lib/shopify-shop'
import { getSheets, getMinAgeDays } from './auto-fulfill-sheets'
import { runAutoFulfill } from './auto-fulfill'
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
  const { conn, error } = await tryStoreConnection(() => getStoreConnectionByShop(LITZZY_SHOP))
  if (!conn) { console.error(`[auto-fulfill] ${error.message}; skipping`); return }
  try {
    const minAgeDays = await getMinAgeDays()
    const result = await runAutoFulfill({ shop: conn.shop, accessToken: conn.token, storeId: conn.storeId, sheets, minAgeDays, apply: true })
    await prisma.appSetting.upsert({
      where: { key: 'last_auto_fulfill_result' },
      create: { key: 'last_auto_fulfill_result', value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
      update: { value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
    })
    console.log(`[auto-fulfill] fulfilled ${result.fulfilled}, tooRecent ${result.tooRecent}, needsManual ${result.needsManual}, errored ${result.errored} of ${result.ordersChecked}`)
  } catch (e: any) {
    console.error('[auto-fulfill] failed:', e?.message ?? e)
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
