import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { transitionTask, type TransitionInput } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({} as any))
  if (!body || typeof body.to !== 'string') return NextResponse.json({ error: 'to is required' }, { status: 400 })

  const input: TransitionInput = {
    to: body.to,
    note: typeof body.note === 'string' ? body.note : undefined,
    reasons: Array.isArray(body.reasons) ? body.reasons : undefined,
    assigneeId: typeof body.assigneeId === 'string' ? body.assigneeId : undefined,
    kpi: typeof body.kpi === 'number' ? body.kpi : undefined,
    dueHours: typeof body.dueHours === 'number' ? body.dueHours : undefined,
    continue: typeof body.continue === 'boolean' ? body.continue : undefined,
    acceptMissingAreas: body.acceptMissingAreas === true ? true : undefined,
  }
  const actor = { id: user.id, name: user.name, role: user.role, permissions: user.permissions }

  try {
    const result = await transitionTask(params.key, actor, input)
    return NextResponse.json(result)
  } catch (e: any) {
    const status = /not found/i.test(e.message) ? 404 : 400
    return NextResponse.json({ error: e.message }, { status })
  }
}
