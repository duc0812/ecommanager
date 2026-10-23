import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { defaultDeps } from '@/lib/cs/agent'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const ticket = await prisma.csTicket.findUnique({ where: { id: params.id } })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const deps = await defaultDeps()
  if (deps) {
    try {
      await deps.fd.update(ticket.fdTicketId, { status: 4 })
    } catch (err: any) {
      return NextResponse.json({ error: `Freshdesk: ${err?.message ?? err}` }, { status: 502 })
    }
  }
  const updated = await prisma.csTicket.update({ where: { id: ticket.id }, data: { resolvedInTool: true, needsHuman: false, fdStatus: 4 } })
  return NextResponse.json({ ticket: updated })
}
