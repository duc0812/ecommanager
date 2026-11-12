import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { getDesignSettings, saveAgentSettings, type AgentSettings } from '@/lib/design-settings'
import { SENT_BACK_REASONS } from '@/lib/design-tasks'
import { agentQueueCounts, backfillRejected } from '@/lib/design-agent/jobs'
import { agentRunnerInfo } from '@/lib/design-agent/runner'
import { agentErrorResponse, readBody } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

const isIntIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try {
    const [settings, runner, queue, backlog] = await Promise.all([
      getDesignSettings(),
      agentRunnerInfo(),
      agentQueueCounts(),
      backfillRejected({ dryRun: true, by: { id: auth.user.id, name: auth.user.name }, factoryReasons: SENT_BACK_REASONS }),
    ])
    return NextResponse.json({ agent: settings.agent, runner, queue, rejectedBacklog: backlog.count })
  } catch (e) {
    return agentErrorResponse(e)
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  try {
    const body = await readBody(req)
    const patch: Partial<AgentSettings> = {}
    if (body.maxConcurrent !== undefined) {
      if (!isIntIn(body.maxConcurrent, 1, 10)) return NextResponse.json({ error: 'maxConcurrent phải là số nguyên từ 1 đến 10' }, { status: 400 })
      patch.maxConcurrent = body.maxConcurrent
    }
    if (body.leaseMinutes !== undefined) {
      if (!isIntIn(body.leaseMinutes, 5, 120)) return NextResponse.json({ error: 'leaseMinutes phải là số nguyên từ 5 đến 120' }, { status: 400 })
      patch.leaseMinutes = body.leaseMinutes
    }
    if (body.autoFixOnReject !== undefined) {
      if (typeof body.autoFixOnReject !== 'boolean') return NextResponse.json({ error: 'autoFixOnReject phải là true hoặc false' }, { status: 400 })
      patch.autoFixOnReject = body.autoFixOnReject
    }
    return NextResponse.json({ agent: await saveAgentSettings(patch) })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
