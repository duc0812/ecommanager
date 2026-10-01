import { prisma } from '@/lib/db'
import type { MetaBillingSyncJob } from '@/lib/meta-billing-sync-types'
import { getMetaBillingSyncJob, startMetaBillingSync } from '@/lib/meta-billing-sync'
import { refreshReserveData } from '@/lib/meta-reserve-sync'
import { syncShopifyPayouts } from '@/lib/shopify-payouts-sync'
import { snapshotProjectMonth } from '@/lib/cashflow-snapshot-scheduler'
import { dateKeyInZone } from '@/lib/cashflow-dates'

export const DAILY_SYNC_RESULT_KEY = 'last_daily_sync_result'
export const DAILY_SYNC_CRON = '0 15 * * *'
export const DAILY_SYNC_TIMEZONE = 'Asia/Ho_Chi_Minh'

const BILLING_TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'INTERRUPTED'])
const BILLING_WAIT_MS = 15 * 60_000
const BILLING_POLL_MS = 5_000

const STEP_ORDER = ['payouts', 'billing', 'reserve', 'snapshot'] as const
export type DailySyncStepName = typeof STEP_ORDER[number]

export type DailySyncSteps = Record<DailySyncStepName, () => Promise<any>>

export type DailySyncResult = {
  startedAt: string
  finishedAt: string
  ok: boolean
  steps: Record<DailySyncStepName, any>
}

function defaultSleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

export async function waitForMetaBillingSync({
  getJob,
  timeoutMs = BILLING_WAIT_MS,
  pollMs = BILLING_POLL_MS,
  now = Date.now,
  sleep = defaultSleep,
}: {
  getJob: () => Promise<MetaBillingSyncJob | null>
  timeoutMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<{ status: string; timedOut: boolean }> {
  const startedAt = now()
  for (;;) {
    const job = await getJob()
    const status = job?.status ?? 'NONE'
    if (!job || BILLING_TERMINAL_STATUSES.has(status)) return { status, timedOut: false }
    if (now() - startedAt >= timeoutMs) return { status, timedOut: true }
    await sleep(pollMs)
  }
}

// The month is closed by the 15:00 run on the 1st, right after the three syncs above, so the
// snapshot records data refreshed minutes earlier rather than yesterday's.
export function monthToCloseOn(now: Date): string | null {
  const todayKey = dateKeyInZone(now, DAILY_SYNC_TIMEZONE)
  const [year, month, day] = todayKey.split('-').map(Number)
  if (day !== 1) return null
  const closing = new Date(Date.UTC(year, month - 2, 1))
  return `${closing.getUTCFullYear()}-${String(closing.getUTCMonth() + 1).padStart(2, '0')}`
}

async function snapshotStep(now: Date) {
  const periodMonth = monthToCloseOn(now)
  if (!periodMonth) return { skipped: true, reason: 'chỉ chốt tháng vào ngày 1' }
  const projects = await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true, name: true } })
  const closed: string[] = []
  const errors: { project: string; error: string }[] = []
  for (const project of projects) {
    try {
      await snapshotProjectMonth(project.id, periodMonth)
      closed.push(project.name)
    } catch (error) {
      errors.push({ project: project.name, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  }
  return { periodMonth, closed, errors }
}

async function billingStep() {
  const started = await startMetaBillingSync(null)
  if (started.alreadyRunning) return { skipped: true, reason: 'Meta billing sync đang chạy' }
  const waited = await waitForMetaBillingSync({ getJob: getMetaBillingSyncJob })
  const job = await getMetaBillingSyncJob()
  return {
    status: waited.status,
    ...(waited.timedOut ? { timedOut: true } : {}),
    totals: job?.totals ?? null,
    accountErrors: (job?.accounts ?? [])
      .filter(account => account.error)
      .map(account => ({ account: account.accountName, error: account.error })),
  }
}

const DEFAULT_STEPS: DailySyncSteps = {
  payouts: () => syncShopifyPayouts(),
  billing: billingStep,
  // Billing runs first: the reserve reads thresholds off billing history, and both call the
  // rate-limited Meta API, so they must not overlap.
  reserve: () => refreshReserveData(),
  snapshot: () => snapshotStep(new Date()),
}

export async function runDailySync(overrides: Partial<DailySyncSteps> = {}): Promise<DailySyncResult> {
  const steps: DailySyncSteps = { ...DEFAULT_STEPS, ...overrides }
  const startedAt = new Date().toISOString()
  const results = {} as Record<DailySyncStepName, any>
  let ok = true

  for (const name of STEP_ORDER) {
    try {
      results[name] = await steps[name]()
    } catch (error) {
      ok = false
      results[name] = { error: error instanceof Error ? error.message : 'Unknown error' }
      console.error(`[daily-sync] ${name} failed:`, error)
    }
  }

  const result: DailySyncResult = {
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    steps: results,
  }

  await prisma.appSetting.upsert({
    where: { key: DAILY_SYNC_RESULT_KEY },
    create: { key: DAILY_SYNC_RESULT_KEY, value: JSON.stringify(result) },
    update: { value: JSON.stringify(result) },
  })

  return result
}

export async function readLastDailySync(): Promise<DailySyncResult | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: DAILY_SYNC_RESULT_KEY } })
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as DailySyncResult
  } catch {
    return null
  }
}
