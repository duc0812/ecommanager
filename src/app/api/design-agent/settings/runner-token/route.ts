import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { agentRunnerInfo, generateAgentRunnerToken, revokeAgentRunnerToken } from '@/lib/design-agent/runner'
import { agentErrorResponse } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  try {
    const token = await generateAgentRunnerToken()
    return NextResponse.json({ token, ...(await agentRunnerInfo()) })
  } catch (e) {
    return agentErrorResponse(e)
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  try {
    await revokeAgentRunnerToken()
    return NextResponse.json(await agentRunnerInfo())
  } catch (e) {
    return agentErrorResponse(e)
  }
}
