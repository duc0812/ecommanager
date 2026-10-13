import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { forbidden, getAuthUser, unauthorized } from '@/lib/api-auth'
import { canEditDesignNote } from '@/lib/roles'
import { updateLine } from '@/lib/design-studio'
import { setTaskCsNote } from '@/lib/design-tasks'

export async function PATCH(req: NextRequest, { params }: { params: { lineId: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({} as any))
  // Marking a line done here skipped the review step; a design is approved or reopened only through its task.
  if (body?.done !== undefined) {
    return NextResponse.json({ error: 'Duyệt hoặc mở lại design phải đi qua task (Gửi duyệt → Duyệt design / Sửa & gửi lại)' }, { status: 400 })
  }
  if (body?.note === undefined) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  if (!canEditDesignNote(user.role, user.permissions)) return forbidden('Chỉ người có quyền Design Tasks hoặc admin sửa được ghi chú CS.')
  const note = body.note === null ? null : String(body.note)

  const line = await prisma.orderLine.findUnique({ where: { id: params.lineId }, select: { orderId: true, shopifyLineId: true } })
  if (!line) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
  try {
    const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: line }, select: { taskKey: true } })
    if (task) await setTaskCsNote(task.taskKey, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }, note)
    else await updateLine(params.lineId, { note })
    const [updated, order] = await Promise.all([
      prisma.orderLine.findUniqueOrThrow({ where: { id: params.lineId }, select: { id: true, designDriveLink: true, designNote: true } }),
      prisma.order.findUniqueOrThrow({ where: { id: line.orderId }, select: { id: true, designReady: true, pipelineStatus: true } }),
    ])
    return NextResponse.json({ line: updated, order })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
