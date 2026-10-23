import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const ticketId = String(body.ticketId ?? '')
  const replyBody = String(body.replyBody ?? '').trim()
  if (!ticketId || !replyBody) return NextResponse.json({ error: 'Thiếu ticketId hoặc replyBody' }, { status: 400 })
  const ticket = await prisma.csTicket.findUnique({
    where: { id: ticketId },
    include: { messages: { where: { author: 'CUSTOMER' }, orderBy: { createdAt: 'asc' } }, analyses: { orderBy: { runAt: 'desc' }, take: 1 } },
  })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const analysis = ticket.analyses[0]
  const situation = [analysis?.summary, ...ticket.messages.map(m => m.bodyText.trim()).filter(Boolean)].filter(Boolean).join('\n\n').slice(0, 2000)
  const created = await prisma.csCase.create({
    data: {
      title: ticket.subject.slice(0, 120) || `Ticket #${ticket.fdTicketId}`,
      category: ticket.category ?? analysis?.category ?? 'OTHER',
      situation,
      resolution: analysis?.proposal ?? '',
      exampleReply: replyBody,
      active: false,
      source: 'PROMOTED',
      promotedFromTicketId: ticket.id,
      createdById: user.id,
    },
  })
  return NextResponse.json({ case: created })
}
