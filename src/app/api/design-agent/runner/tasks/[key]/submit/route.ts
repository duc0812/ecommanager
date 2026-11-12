import { NextRequest, NextResponse } from 'next/server'
import { agentSubmit, runningJobCovering } from '@/lib/design-agent/delivery'
import { agentErrorResponse, requireRunner } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    if (!(await runningJobCovering(params.key))) return NextResponse.json({ error: 'Task không có job Agent đang chạy' }, { status: 409 })
    const r = await agentSubmit(params.key)
    if (r.moved) return NextResponse.json({ ok: true, status: 'REVIEW' })
    return NextResponse.json({ error: r.error, ...(r.status === 400 ? { missing: r.missing } : {}) }, { status: r.status })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
