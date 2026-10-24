import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { runExclusive } from '@/lib/job-lock'
import { defaultDeps } from '@/lib/cs/agent'
import { runReviewBackfill } from '@/lib/cs/backfill'

export const dynamic = 'force-dynamic'

export async function GET() {
  const row = await prisma.appSetting.findUnique({ where: { key: 'last_cs_review_backfill' } })
  const remaining = await prisma.csTicket.count({ where: { reviewedAt: null, messages: { some: { author: { in: ['STAFF', 'AGENT'] }, private: false } } } })
  return NextResponse.json({ last: row ? JSON.parse(row.value) : null, remaining })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const deps = await defaultDeps()
  if (!deps?.llm) return NextResponse.json({ error: 'Chưa cấu hình model (API key) trong Cài đặt CS' }, { status: 400 })
  const r = await runExclusive('cs-backfill', () => runReviewBackfill({ llm: deps.llm!, maxCalls: 20 }))
  if (r.skipped) return NextResponse.json({ error: 'Backfill đang chạy, thử lại sau' }, { status: 409 })
  return NextResponse.json(r.result)
}
