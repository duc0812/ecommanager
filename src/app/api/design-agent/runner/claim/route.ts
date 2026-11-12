import { NextRequest, NextResponse } from 'next/server'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'
import { claimAgentJobsWithWait } from '@/lib/design-agent/runner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    const free = typeof body.free === 'number' ? body.free : 0
    const wait = typeof body.waitSeconds === 'number' ? body.waitSeconds : 0
    return NextResponse.json({ jobs: await claimAgentJobsWithWait(free, wait, req.signal) })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
