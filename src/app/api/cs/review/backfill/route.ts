import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { isJobRunning, runExclusive } from '@/lib/job-lock'
import { defaultDeps } from '@/lib/cs/agent'
import { remainingBackfill, runBackfillUntilDone } from '@/lib/cs/backfill'

export const dynamic = 'force-dynamic'

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'last_cs_review_backfill' } })
  return NextResponse.json({ last: row ? JSON.parse(row.value) : null, remaining: await remainingBackfill(), running: isJobRunning('cs-backfill') })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const deps = await defaultDeps()
  if (!deps?.llm) return NextResponse.json({ error: 'Chưa cấu hình model (API key) trong Cài đặt CS' }, { status: 400 })
  if (isJobRunning('cs-backfill')) return NextResponse.json({ error: 'Backfill đang chạy', running: true }, { status: 409 })
  const remaining = await remainingBackfill()
  if (remaining === 0) return NextResponse.json({ started: false, remaining: 0 })
  void runExclusive('cs-backfill', () => runBackfillUntilDone({ llm: deps.llm! }))
    .then(r => { if (!r.skipped) console.log(`[cs] backfill done: ${r.result.processed} processed in ${r.result.batches} batches, ${r.result.remaining} remaining${r.result.capReached ? ' (cap)' : ''}`) })
    .catch(err => console.error('[cs] backfill failed:', err))
  return NextResponse.json({ started: true, remaining })
}
