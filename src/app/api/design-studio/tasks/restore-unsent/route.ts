import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { restoreUnsentCancelledTasks } from '@/lib/design-task-restore'

export const dynamic = 'force-dynamic'

/** Tasks the sync cancelled for a fulfilled order while no supplier got the line (owner 11/20/2026). GET lists them; POST {apply:true} restores them. */
export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await restoreUnsentCancelledTasks({ apply: false }))
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({} as any))
  const taskKeys = Array.isArray(body?.taskKeys) ? body.taskKeys.filter((k: unknown): k is string => typeof k === 'string') : undefined
  return NextResponse.json(await restoreUnsentCancelledTasks({ apply: body?.apply === true, taskKeys }))
}
