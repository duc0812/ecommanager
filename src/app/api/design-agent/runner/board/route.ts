import { NextRequest, NextResponse } from 'next/server'
import { agentErrorResponse, readBody, requireRunner } from '@/lib/design-agent/route-http'
import { parseBoardEntries, replaceWorkBoard } from '@/lib/design-agent/work-board'

export const dynamic = 'force-dynamic'

export async function PUT(req: NextRequest) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const body = await readBody(req)
    const entries = parseBoardEntries(body.entries)
    const rejectedOwner = typeof body.rejectedOwner === 'string' ? body.rejectedOwner : null
    const { count } = await replaceWorkBoard({ entries, rejectedOwner })
    return NextResponse.json({ ok: true, count })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
