import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { STAGES } from '@/lib/cs/root-cause-prompt'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const stage = body.stage === null ? null : String(body.stage ?? '')
  if (stage !== null && !(STAGES as readonly string[]).includes(stage)) return NextResponse.json({ error: 'Khâu không hợp lệ' }, { status: 400 })
  const ticket = await prisma.csTicket.findUnique({ where: { id: params.id } })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const updated = await prisma.csTicket.update({
    where: { id: ticket.id },
    data: { rootCauseStageOverride: stage, rootCauseNote: typeof body.note === 'string' ? body.note.trim() || null : ticket.rootCauseNote, rootCauseById: stage ? user.id : null },
  })
  return NextResponse.json({ ticket: updated })
}
