import { NextRequest, NextResponse } from 'next/server'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'
import { completeAgentJob } from '@/lib/design-agent/runner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    const r = await completeAgentJob(params.id, { outcome: body.outcome, summary: body.summary, rounds: body.rounds, result: body.result })
    if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ ok: true, status: r.status })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
