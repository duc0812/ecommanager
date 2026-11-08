import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { addTaskComment } from '@/lib/cs/tasks'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!(await prisma.csTask.findUnique({ where: { id: params.id }, select: { id: true } }))) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  try {
    const event = await addTaskComment(params.id, String(body.body ?? ''), { id: user.id, name: user.name })
    return NextResponse.json({ event })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Không lưu được bình luận' }, { status: 400 })
  }
}
