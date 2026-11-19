import { NextResponse, type NextRequest } from 'next/server'
import { AgentJobError } from '@/lib/design-agent/jobs'
import { markAgentRunnerSeen, verifyAgentRunnerRequest } from '@/lib/design-agent/runner'

/** `seen: false` for calls that are not the runner working (the board publisher), so they never make a lost runner look online. */
export async function requireRunner(req: NextRequest, opts: { seen?: boolean } = {}): Promise<NextResponse | null> {
  if (!(await verifyAgentRunnerRequest(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (opts.seen !== false) await markAgentRunnerSeen()
  return null
}

export function agentErrorResponse(e: unknown): NextResponse {
  if (e instanceof AgentJobError) return NextResponse.json({ error: e.message }, { status: e.status })
  console.error('[design agent api]', e)
  return NextResponse.json({ error: 'Lỗi máy chủ.' }, { status: 500 })
}

export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}
