import cron from 'node-cron'
import { initOnce } from '@/lib/job-lock'
import { getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { SCHEDULED_PUSH_LIMIT, resumeBulkDrivePush, runDrivePushJob } from '@/lib/drive-push-queue'

export const DRIVE_PUSH_CRON = '4-59/10 * * * *'

export async function runScheduledDrivePush() {
  try {
    const cfg = await getGoogleConfig()
    if (!isDriveConfigured(cfg) || cfg.needsReconnect) return
    const r = await runDrivePushJob('schedule', { limit: SCHEDULED_PUSH_LIMIT })
    if (r.skipped) { console.warn('[drive-push] previous run still active; skipped'); return }
    const s = r.result
    if (s.pushed || s.failed || s.missing || s.organized || s.stuck || s.stopped) {
      console.log(`[drive-push] ${s.pushed} pushed, ${s.failed} failed, ${s.missing} missing on disk, ${s.pending} still on the server, ${s.organized} moved into task folders, ${s.stuck} Drive would not move${s.stopped ? `, stopped: ${s.stopped}` : ''}${s.lastError ? `, last error: ${s.lastError}` : ''}`)
    }
  } catch (e: any) {
    console.error('[drive-push] failed:', e?.message ?? e)
  } finally {
    resumeBulkDrivePush()
  }
}

export function initDrivePushScheduler() {
  if (!initOnce('drive-push-scheduler')) return
  cron.schedule(DRIVE_PUSH_CRON, () => { void runScheduledDrivePush() })
  console.log('[drive-push] Initialized — artworks left on the server go to Google Drive every 10 minutes')
}
