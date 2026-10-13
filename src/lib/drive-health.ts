import { getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { countPendingArtworks } from '@/lib/drive-push-queue'

export const QUOTA_WARNING_PERCENT = 90

export type DriveHealth = {
  state: 'not_connected' | 'needs_reconnect' | 'connected'
  pending: number
  quota: { limit: number | null; usage: number; percent: number | null; checkedAt: string } | null
  quotaWarning: boolean
}

/** Reads only the database: the quota is the snapshot the push job stores, so a page load never calls Google. */
export async function getDriveHealth(): Promise<DriveHealth> {
  const [cfg, pending] = await Promise.all([getGoogleConfig(), countPendingArtworks()])
  const connected = isDriveConfigured(cfg)
  const state = !connected ? 'not_connected' : cfg.needsReconnect ? 'needs_reconnect' : 'connected'
  const q = connected ? cfg.quota : null
  const percent = q && q.limit ? Math.round((q.usage / q.limit) * 1000) / 10 : null
  return {
    state, pending,
    quota: q ? { limit: q.limit, usage: q.usage, percent, checkedAt: q.checkedAt } : null,
    quotaWarning: percent !== null && percent > QUOTA_WARNING_PERCENT,
  }
}
