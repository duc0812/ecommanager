import { NextRequest, NextResponse } from 'next/server'
import { requireTaskScope } from '@/lib/order-scope'
import { addTaskNote } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const scope = await requireTaskScope(req, params.key)
  if ('error' in scope) return scope.error
  const { user } = scope
  const body = await req.json().catch(() => ({} as any))
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!message) return NextResponse.json({ error: 'message is required' }, { status: 400 })

  const actor = { id: user.id, name: user.name, role: user.role }
  try {
    await addTaskNote(params.key, actor, message)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    const status = /not found/i.test(e.message) ? 404 : 400
    return NextResponse.json({ error: e.message }, { status })
  }
}
