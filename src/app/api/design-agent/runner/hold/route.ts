import { NextRequest, NextResponse } from 'next/server'
import { agentHold } from '@/lib/design-agent/delivery'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    const r = await agentHold(typeof body.taskKey === 'string' ? body.taskKey : '', body.reason as string)
    return NextResponse.json({ ok: true, jobId: r.jobId })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
