import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { syncParcelPanelTracking } from './parcelpanel-sync'
import { getParcelPanelApiKey } from './parcelpanel-config'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false

// Daily: refresh real carrier status from ParcelPanel for undelivered shipments.
export async function runDailyParcelPanelSync() {
  const apiKey = await getParcelPanelApiKey()
  if (!apiKey) {
    console.log('[parcelpanel] API key not configured (DB or env); skipping')
    return
  }
  const conn = await getShopifyConnection()
  const store = conn ? await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } }) : null
  try {
    const result = await syncParcelPanelTracking({ apiKey, storeId: store?.id })
    await prisma.appSetting.upsert({
      where: { key: 'last_parcelpanel_sync_result' },
      create: { key: 'last_parcelpanel_sync_result', value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
      update: { value: JSON.stringify({ ...result, ranAt: new Date().toISOString() }) },
    })
    console.log(`[parcelpanel] ${result.shipmentsUpdated} shipments updated (${result.delivered} delivered) of ${result.ordersChecked} orders`)
    if (result.errors.length) console.error('[parcelpanel] errors:', result.errors.slice(0, 5))
  } catch (e: any) {
    console.error('[parcelpanel] failed:', e?.message ?? e)
  }
}

export function initParcelPanelScheduler() {
  if (initialized) return
  initialized = true
  cron.schedule('0 4 * * *', () => {
    runDailyParcelPanelSync().catch(err => console.error('[parcelpanel] unhandled:', err))
  }, { timezone: TZ })
  console.log('[parcelpanel] Initialized — daily ParcelPanel tracking sync at 04:00 Asia/Ho_Chi_Minh')
}
