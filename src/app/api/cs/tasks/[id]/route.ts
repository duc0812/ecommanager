import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { taskDetail, updateTask } from '@/lib/cs/tasks'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const detail = await taskDetail(params.id)
  if (!detail) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  return NextResponse.json(detail)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!(await prisma.csTask.findUnique({ where: { id: params.id }, select: { id: true } }))) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  try {
    const task = await updateTask(params.id, { status: body.status ?? undefined, dept: body.dept ?? undefined, note: body.note ?? undefined, amount: body.amount }, { id: user.id, name: user.name })
    return NextResponse.json({ task })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Không cập nhật được task' }, { status: 400 })
  }
}
