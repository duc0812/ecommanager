import { NextRequest, NextResponse } from 'next/server'
import { runExclusive, isJobRunning } from '@/lib/job-lock'
import { DAILY_SYNC_CRON, DAILY_SYNC_TIMEZONE, readLastDailySync, runDailySync } from '@/lib/daily-sync'
import { dailySyncForScope } from '@/lib/daily-sync-scope'
import { requireFinanceScope, requireUnrestricted } from '@/lib/finance-scope'
import { storeScopeFor } from '@/lib/store-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// canRun says whether the caller may start the run, which covers every store.
export async function GET(req: NextRequest) {
  const scope = await requireFinanceScope(req)
  if ('error' in scope) return scope.error
  return NextResponse.json({
    schedule: { cron: DAILY_SYNC_CRON, timezone: DAILY_SYNC_TIMEZONE, label: '15:00 giờ Việt Nam' },
    running: isJobRunning('daily-sync'),
    last: await dailySyncForScope(await readLastDailySync(), scope),
    canRun: (await storeScopeFor(scope.user)).all,
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireUnrestricted(req)
  if ('error' in auth) return auth.error
  const outcome = await runExclusive('daily-sync', runDailySync)
  if (outcome.skipped) {
    return NextResponse.json({ skipped: true, error: 'Daily sync đang chạy' }, { status: 409 })
  }
  return NextResponse.json({ last: outcome.result })
}
