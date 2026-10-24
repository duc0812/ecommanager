import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { defaultDeps } from '@/lib/cs/agent'
import { generateReport } from '@/lib/cs/report'
import { parsePeriod } from '@/lib/cs/insights'
import { LlmCapReached } from '@/lib/llm/cap'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const deps = await defaultDeps()
  if (!deps?.llm) return NextResponse.json({ error: 'Chưa cấu hình model (API key) trong Cài đặt CS' }, { status: 400 })
  const body = await req.json().catch(() => ({}))
  const params = new URLSearchParams()
  if (body.from) params.set('from', String(body.from))
  if (body.to) params.set('to', String(body.to))
  const period = parsePeriod(params)
  try {
    const report = await generateReport(period, 'MANUAL', { llm: deps.llm, appUrl: deps.appUrl })
    return NextResponse.json({ report })
  } catch (err: any) {
    if (err instanceof LlmCapReached) return NextResponse.json({ error: 'Đã chạm trần số lần gọi model hôm nay' }, { status: 429 })
    return NextResponse.json({ error: err?.message ?? String(err) }, { status: 502 })
  }
}
