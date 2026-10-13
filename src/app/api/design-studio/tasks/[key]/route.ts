import { NextRequest, NextResponse } from 'next/server'
import { forbidden, getAuthUser, unauthorized } from '@/lib/api-auth'
import { loadTask, setTaskCsNote, viewerFor } from '@/lib/design-tasks'
import { canEditDesignNote } from '@/lib/roles'
import { handoffStateFor } from '@/lib/supplier-handoff'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const detail = await loadTask(params.key)
  if (!detail) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  return NextResponse.json({ ...detail, handoff: await handoffStateFor(detail.task.orderId), me: viewerFor(user, detail.settings) })
}

export async function PATCH(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!canEditDesignNote(user.role, user.permissions)) return forbidden('Chỉ người có quyền Design Tasks hoặc admin sửa được ghi chú CS.')
  const body = await req.json().catch(() => ({} as any))
  if (body?.designNote === undefined || (body.designNote !== null && typeof body.designNote !== 'string')) {
    return NextResponse.json({ error: 'designNote (string | null) is required' }, { status: 400 })
  }
  try {
    return NextResponse.json(await setTaskCsNote(params.key, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }, body.designNote))
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: /not found/i.test(e.message) ? 404 : 400 })
  }
}
