import { NextRequest, NextResponse } from 'next/server'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'
import { yieldAgentJob } from '@/lib/design-agent/runner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    const r = await yieldAgentJob(params.id, { worker: body.worker, detail: body.detail })
    if (!r) return NextResponse.json({ error: 'not running' }, { status: 409 })
    return NextResponse.json({ ok: true, status: r.status })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
