import cron from 'node-cron'
import { initOnce } from '@/lib/job-lock'
import { runDesignTaskSyncJob } from '@/lib/design-task-sync'

export const DESIGN_TASK_SYNC_CRON = '*/15 * * * *'

export async function runScheduledDesignTaskSync() {
  try {
    const r = await runDesignTaskSyncJob('schedule')
    if (r.skipped) { console.warn('[design-task-sync] previous run still active; skipped'); return }
    const s = r.result
    if (s.created || s.cancelled || s.completed || s.reopened || s.errors.length || s.refresh.error) {
      console.log(`[design-task-sync] ${s.orders} orders: +${s.created} task, ${s.cancelled} cancelled, ${s.completed} done outside, ${s.reopened} reopened, ${s.errors.length} errors${s.refresh.error ? `, Shopify refresh: ${s.refresh.error}` : ''}`)
    }
  } catch (e: any) {
    console.error('[design-task-sync] failed:', e?.message ?? e)
  }
}

export function initDesignTaskSyncScheduler() {
  if (!initOnce('design-task-sync-scheduler')) return
  cron.schedule(DESIGN_TASK_SYNC_CRON, () => { void runScheduledDesignTaskSync() })
  console.log('[design-task-sync] Initialized — design task intake every 15 minutes')
}
