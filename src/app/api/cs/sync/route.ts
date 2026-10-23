import { NextResponse } from 'next/server'
import { runExclusive } from '@/lib/job-lock'
import { defaultDeps, runAgentCycle } from '@/lib/cs/agent'

export const dynamic = 'force-dynamic'

export async function POST() {
  const deps = await defaultDeps()
  if (!deps) return NextResponse.json({ error: 'Chưa cấu hình Freshdesk API key' }, { status: 400 })
  const r = await runExclusive('cs-agent', () => runAgentCycle(deps))
  if (r.skipped) return NextResponse.json({ error: 'Một lượt đồng bộ đang chạy, thử lại sau' }, { status: 409 })
  return NextResponse.json({ run: r.result })
}
