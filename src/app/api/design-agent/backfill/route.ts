import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { SENT_BACK_REASONS } from '@/lib/design-tasks'
import { backfillRejected } from '@/lib/design-agent/jobs'
import { agentErrorResponse, readBody } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  try {
    const body = await readBody(req)
    return NextResponse.json(await backfillRejected({
      dryRun: body.dryRun !== false, by: { id: auth.user.id, name: auth.user.name }, factoryReasons: SENT_BACK_REASONS,
    }))
  } catch (e) {
    return agentErrorResponse(e)
  }
}
