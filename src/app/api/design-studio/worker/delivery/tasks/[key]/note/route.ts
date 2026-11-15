import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireDeliveryWorker } from '@/lib/delivery/guard'

export const dynamic = 'force-dynamic'

const NOTE_MAX = 500

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied

  const body = await req.json().catch(() => null)
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > NOTE_MAX) {
    return NextResponse.json({ error: `message phải là chữ, 1–${NOTE_MAX} ký tự`, code: 'bad_request' }, { status: 400 })
  }
  const task = await prisma.designTask.findUnique({ where: { taskKey: params.key }, select: { id: true } })
  if (!task) return NextResponse.json({ error: 'Không tìm thấy task', code: 'not_found' }, { status: 404 })
  await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message, actorId: null } })
  return NextResponse.json({ ok: true })
}
