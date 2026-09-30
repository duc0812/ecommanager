import cron from 'node-cron'
import { initOnce, runExclusive } from '@/lib/job-lock'
import { DAILY_SYNC_CRON, DAILY_SYNC_TIMEZONE, runDailySync } from '@/lib/daily-sync'

export function initDailySyncScheduler() {
  if (!initOnce('daily-sync-scheduler')) return
  // Shopify payouts + Meta billing + reserve refresh, 15:00 Asia/Ho_Chi_Minh
  cron.schedule(DAILY_SYNC_CRON, () => {
    runExclusive('daily-sync', runDailySync)
      .then(r => {
        if (r.skipped) console.warn('[daily-sync] previous run still active; skipped')
        else console.log(`[daily-sync] done ok=${r.result.ok}`)
      })
      .catch(err => console.error('[daily-sync] unhandled:', err))
  }, { timezone: DAILY_SYNC_TIMEZONE })
  console.log(`[daily-sync] Initialized — daily sync at 15:00 ${DAILY_SYNC_TIMEZONE}`)
}
