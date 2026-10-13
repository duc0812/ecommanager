import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { isJobRunning, runExclusive } from '@/lib/job-lock'
import { localArtworkPath } from '@/lib/design-storage'
import { RECONNECT_WARNING, pushArtworkToDrive } from '@/lib/design-drive-push'
import { getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { refreshDriveQuota } from '@/lib/google-drive'

export const DRIVE_PUSH_JOB = 'drive-push'
export const DRIVE_PUSH_RESULT_KEY = 'last_drive_push_result'
export const SCHEDULED_PUSH_LIMIT = 20
export const BULK_PUSH_LIMIT = 5000
export const MAX_CONSECUTIVE_FAILURES = 5
const SCAN_LIMIT = 5000
const BACKOFF_BASE_MS = 30 * 60 * 1000
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

export type PushTrigger = 'schedule' | 'manual'
export type PushStop = 'not_connected' | 'needs_reconnect' | 'too_many_failures'
export type PushSummary = {
  pending: number; attempted: number; pushed: number; failed: number; skipped: number; missing: number
  lastError: string | null; stopped: PushStop | null
}
export type PushProgress = PushSummary & { running: boolean; trigger: PushTrigger; startedAt: string; finishedAt: string | null }

type QueueState = {
  chain: Promise<unknown>
  background: Set<Promise<unknown>>
  failures: Map<string, { count: number; retryAt: number }>
  run: PushProgress | null
  bulkRequested: boolean
  uploadError: { message: string; at: string } | null
}

declare global {
  // eslint-disable-next-line no-var
  var __drivePushQueue: QueueState | undefined
}

function state(): QueueState {
  if (!globalThis.__drivePushQueue) {
    globalThis.__drivePushQueue = { chain: Promise.resolve(), background: new Set(), failures: new Map(), run: null, bulkRequested: false, uploadError: null }
  }
  return globalThis.__drivePushQueue
}

export function resetDrivePushQueue() {
  const s = state()
  s.failures.clear()
  s.run = null
  s.bulkRequested = false
  s.uploadError = null
}

const PENDING_WHERE = { storage: 'LOCAL', removedAt: null } as const

/** Every push goes through one chain, so only one 8 MB chunk is in memory at a time however many uploads arrive together. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const s = state()
  const next = s.chain.then(fn, fn)
  s.chain = next.catch(() => {})
  return next
}

function track(promise: Promise<unknown>) {
  const s = state()
  const settled = promise.catch(err => console.error('[drive push] background task failed:', err?.message ?? err))
  s.background.add(settled)
  void settled.then(() => { s.background.delete(settled) })
}

function noteFailure(artworkId: string) {
  const failures = state().failures
  const count = (failures.get(artworkId)?.count ?? 0) + 1
  failures.set(artworkId, { count, retryAt: Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (count - 1)) })
}

/**
 * Called right after an upload is stored. The caller answers without waiting; the push happens here.
 * Nothing is thrown to the caller; a failed push leaves the artwork on the server for the scheduled queue.
 */
export function enqueueDrivePush(artworkId: string) {
  track(serial(async () => {
    const cfg = await getGoogleConfig()
    if (!isDriveConfigured(cfg) || cfg.needsReconnect) return
    const result = await pushArtworkToDrive(artworkId)
    const s = state()
    if (result.pushed) {
      s.failures.delete(artworkId)
      s.uploadError = null
    } else if (result.warning && !result.inProgress) {
      if (result.warning !== RECONNECT_WARNING) noteFailure(artworkId)
      s.uploadError = { message: result.warning, at: new Date().toISOString() }
    }
  }))
}

/** Resolves once every background push and bulk run started so far has settled. */
export async function drainDrivePushes() {
  const s = state()
  while (s.background.size > 0) await Promise.all(Array.from(s.background))
}

export function countPendingArtworks(): Promise<number> {
  return prisma.designArtwork.count({ where: PENDING_WHERE })
}

async function localFileExists(storagePath: string | null): Promise<boolean> {
  const abs = localArtworkPath(storagePath)
  if (!abs) return false
  return fs.stat(abs).then(s => s.isFile() && s.size > 0, () => false)
}

/**
 * Pushes artworks still on the server, oldest first, one at a time. Safe next to the per-upload push and the
 * "Đẩy lên Drive" button: `pushArtworkToDrive` holds an in-process lock per artwork and a row already on Drive is left alone.
 * `force` retries files that failed recently (a scheduled run waits out their back-off).
 */
export async function pushPendingArtworksToDrive(opts: { limit?: number; force?: boolean; onProgress?: (p: PushSummary) => void } = {}): Promise<PushSummary> {
  const limit = Math.max(1, opts.limit ?? SCHEDULED_PUSH_LIMIT)
  const summary: PushSummary = { pending: await countPendingArtworks(), attempted: 0, pushed: 0, failed: 0, skipped: 0, missing: 0, lastError: null, stopped: null }
  const report = () => opts.onProgress?.({ ...summary })
  const cfg = await getGoogleConfig()
  if (!isDriveConfigured(cfg)) { summary.stopped = 'not_connected'; report(); return summary }
  if (cfg.needsReconnect) { summary.stopped = 'needs_reconnect'; summary.lastError = RECONNECT_WARNING; report(); return summary }

  const rows = await prisma.designArtwork.findMany({
    where: PENDING_WHERE, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, storagePath: true }, take: SCAN_LIMIT,
  })
  const now = Date.now()
  const failures = state().failures
  const candidates = rows.filter(r => opts.force || (failures.get(r.id)?.retryAt ?? 0) <= now).slice(0, limit)
  let consecutive = 0
  report()
  for (const row of candidates) {
    if (!(await localFileExists(row.storagePath))) { summary.missing++; report(); continue }
    summary.attempted++
    const result = await serial(() => pushArtworkToDrive(row.id))
    if (result.inProgress) {
      summary.attempted--
      summary.skipped++
    } else if (result.pushed) {
      summary.pushed++
      consecutive = 0
      failures.delete(row.id)
    } else if (result.warning === null) {
      summary.attempted--
      summary.stopped = 'not_connected'
    } else {
      summary.failed++
      summary.lastError = result.warning
      if (result.warning === RECONNECT_WARNING) summary.stopped = 'needs_reconnect'
      else {
        noteFailure(row.id)
        if (++consecutive >= MAX_CONSECUTIVE_FAILURES) summary.stopped = 'too_many_failures'
      }
    }
    report()
    if (summary.stopped) break
  }
  summary.pending = await countPendingArtworks()
  report()
  return summary
}

async function saveLast(value: unknown) {
  const json = JSON.stringify(value)
  await prisma.appSetting.upsert({ where: { key: DRIVE_PUSH_RESULT_KEY }, create: { key: DRIVE_PUSH_RESULT_KEY, value: json }, update: { value: json } })
}

/** One run at a time in this process: the 10-minute schedule and the bulk button share the lock. */
export async function runDrivePushJob(trigger: PushTrigger, opts: { limit: number; force?: boolean }) {
  return runExclusive(DRIVE_PUSH_JOB, async () => {
    const s = state()
    const startedAt = new Date().toISOString()
    const blank: PushSummary = { pending: 0, attempted: 0, pushed: 0, failed: 0, skipped: 0, missing: 0, lastError: null, stopped: null }
    s.run = { ...blank, running: true, trigger, startedAt, finishedAt: null }
    try {
      const summary = await pushPendingArtworksToDrive({ ...opts, onProgress: p => { s.run = { ...p, running: true, trigger, startedAt, finishedAt: null } } })
      let quotaError: string | null = null
      if (summary.stopped !== 'not_connected' && summary.stopped !== 'needs_reconnect') {
        await refreshDriveQuota().catch(err => { quotaError = err?.message ?? String(err) })
      }
      const finishedAt = new Date().toISOString()
      s.run = { ...summary, running: false, trigger, startedAt, finishedAt }
      await saveLast({ trigger, startedAt, ranAt: finishedAt, ...summary, quotaError })
      return summary
    } catch (e: any) {
      const finishedAt = new Date().toISOString()
      const message = e?.message ?? String(e)
      s.run = { ...(s.run ?? blank), running: false, trigger, startedAt, finishedAt, lastError: message }
      await saveLast({ trigger, startedAt, ranAt: finishedAt, error: message }).catch(() => {})
      throw e
    }
  })
}

async function pumpBulk() {
  const s = state()
  while (s.bulkRequested) {
    const outcome = await runExclusive(`${DRIVE_PUSH_JOB}:bulk-pump`, async () => {
      if (isJobRunning(DRIVE_PUSH_JOB)) return 'busy' as const
      s.bulkRequested = false
      const run = await runDrivePushJob('manual', { limit: BULK_PUSH_LIMIT, force: true })
      if (run.skipped) {
        s.bulkRequested = true
        return 'busy' as const
      }
      return 'ran' as const
    })
    if (outcome.skipped || outcome.result === 'busy') return
  }
}

/** Starts a full run, or asks for one as soon as the run in flight (a scheduled one has a small limit) finishes. */
export function startBulkDrivePush(): { started: boolean } {
  const busy = isJobRunning(DRIVE_PUSH_JOB)
  state().bulkRequested = true
  track(pumpBulk())
  return { started: !busy }
}

export function resumeBulkDrivePush() {
  if (state().bulkRequested) track(pumpBulk())
}

export type LastDrivePush = Partial<PushSummary> & { trigger: PushTrigger; ranAt: string; error: string | null }

export async function getLastDrivePush(): Promise<LastDrivePush | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: DRIVE_PUSH_RESULT_KEY } })
  if (!row) return null
  try {
    const v = JSON.parse(row.value)
    if (typeof v?.ranAt !== 'string') return null
    return { ...v, trigger: v.trigger === 'manual' ? 'manual' : 'schedule', error: typeof v.error === 'string' ? v.error : null }
  } catch { return null }
}

export type DrivePushStatus = {
  pending: number; running: boolean; queued: boolean; trigger: PushTrigger | null
  pushed: number; failed: number; missing: number; attempted: number
  lastError: string | null; stopped: PushStop | null; startedAt: string | null; finishedAt: string | null
  uploadError: { message: string; at: string } | null
}

export async function getDrivePushStatus(): Promise<DrivePushStatus> {
  const s = state()
  const pending = await countPendingArtworks()
  const running = isJobRunning(DRIVE_PUSH_JOB)
  if (s.run) {
    const r = s.run
    return {
      pending, running, queued: s.bulkRequested, trigger: r.trigger, pushed: r.pushed, failed: r.failed, missing: r.missing, attempted: r.attempted,
      lastError: r.lastError, stopped: r.stopped, startedAt: r.startedAt, finishedAt: r.finishedAt, uploadError: s.uploadError,
    }
  }
  const last = await getLastDrivePush()
  return {
    pending, running, queued: s.bulkRequested, trigger: last?.trigger ?? null,
    pushed: last?.pushed ?? 0, failed: last?.failed ?? 0, missing: last?.missing ?? 0, attempted: last?.attempted ?? 0,
    lastError: last?.error ?? last?.lastError ?? null, stopped: last?.stopped ?? null, startedAt: null, finishedAt: last?.ranAt ?? null,
    uploadError: s.uploadError,
  }
}

export async function lastSuccessfulPushAt(): Promise<string | null> {
  const row = await prisma.designArtworkUpload.findFirst({
    where: { completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, select: { completedAt: true },
  })
  return row?.completedAt ? row.completedAt.toISOString() : null
}
