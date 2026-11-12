import { NextRequest, NextResponse } from 'next/server'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'
import { heartbeatAgentJob } from '@/lib/design-agent/runner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    if (!(await heartbeatAgentJob(params.id, { stage: body.stage, rounds: body.rounds }))) return NextResponse.json({ error: 'not running' }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
