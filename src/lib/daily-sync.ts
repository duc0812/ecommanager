import { prisma } from '@/lib/db'
import type { MetaBillingSyncJob } from '@/lib/meta-billing-sync-types'
import { getMetaBillingSyncJob, startMetaBillingSync } from '@/lib/meta-billing-sync'
import { refreshReserveData } from '@/lib/meta-reserve-sync'
import { syncShopifyPayouts } from '@/lib/shopify-payouts-sync'

export const DAILY_SYNC_RESULT_KEY = 'last_daily_sync_result'
export const DAILY_SYNC_CRON = '0 15 * * *'
export const DAILY_SYNC_TIMEZONE = 'Asia/Ho_Chi_Minh'

const BILLING_TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'INTERRUPTED'])
const BILLING_WAIT_MS = 15 * 60_000
const BILLING_POLL_MS = 5_000

const STEP_ORDER = ['payouts', 'billing', 'reserve'] as const
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
