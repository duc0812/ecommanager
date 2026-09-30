import { NextResponse } from 'next/server'
import { runExclusive, isJobRunning } from '@/lib/job-lock'
import { DAILY_SYNC_CRON, DAILY_SYNC_TIMEZONE, readLastDailySync, runDailySync } from '@/lib/daily-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    schedule: { cron: DAILY_SYNC_CRON, timezone: DAILY_SYNC_TIMEZONE, label: '15:00 giờ Việt Nam' },
    running: isJobRunning('daily-sync'),
    last: await readLastDailySync(),
  })
}

export async function POST() {
  const outcome = await runExclusive('daily-sync', runDailySync)
  if (outcome.skipped) {
    return NextResponse.json({ skipped: true, error: 'Daily sync đang chạy' }, { status: 409 })
  }
  return NextResponse.json({ last: outcome.result })
}
