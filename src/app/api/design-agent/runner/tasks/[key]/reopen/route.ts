import { NextRequest, NextResponse } from 'next/server'
import { agentReopenTask, runningJobCovering } from '@/lib/design-agent/delivery'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const job = await runningJobCovering(params.key)
    if (!job) return NextResponse.json({ error: 'Task không có job Agent đang chạy' }, { status: 409 })
    const body = await readBody(req)
    const r = await agentReopenTask(params.key, { reason: body.reason, note: body.note }, { allowSent: job.kind === 'LIBRARY_APPLY' })
    return NextResponse.json({ ok: true, status: r.status, sent: r.sent })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
