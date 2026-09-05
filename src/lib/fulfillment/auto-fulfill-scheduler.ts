import cron from 'node-cron'
import { prisma } from '@/lib/db'
import { getShopifyConnection } from '@/lib/token-store'
import { getSheets, getMinAgeDays } from './auto-fulfill-sheets'
import { runAutoFulfill } from './auto-fulfill'

const TZ = 'Asia/Ho_Chi_Minh'
let initialized = false

export async function runDailyAutoFulfill() {
  const sheets = (await getSheets()).filter(s => s.enabled)
  if (sheets.length === 0) { console.log('[auto-fulfill] no enabled sheets; skipping'); return }
  const conn = await getShopifyConnection()
  if (!conn) { console.log('[auto-fulfill] no Shopify connection; skipping'); return }
  const store = await prisma.shopifyStore.findUnique({ where: { shop: conn.shop } })
  if (!store) { console.log('[auto-fulfill] connected store not in DB; skipping'); return }
  try {
    const minAgeDays = await getMinAgeDays()
    const result = await runAutoFulfill({ shop: conn.shop, accessToken: conn.token, storeId: store.id, sheets, minAgeDays, apply: true })
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
  if (initialized) return
  initialized = true
  cron.schedule('30 3 * * *', () => { runDailyAutoFulfill().catch(err => console.error('[auto-fulfill] unhandled:', err)) }, { timezone: TZ })
  console.log('[auto-fulfill] Initialized — daily auto-fulfill at 03:30 Asia/Ho_Chi_Minh')
}
