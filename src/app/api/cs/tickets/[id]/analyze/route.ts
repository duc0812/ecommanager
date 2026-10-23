import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { defaultDeps, runAgentCycle } from '@/lib/cs/agent'

export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ticket = await prisma.csTicket.findUnique({ where: { id: params.id } })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const deps = await defaultDeps()
  if (!deps) return NextResponse.json({ error: 'Chưa cấu hình Freshdesk API key' }, { status: 400 })
  if (!deps.llm) return NextResponse.json({ error: 'Chưa cấu hình Anthropic API key' }, { status: 400 })
  await prisma.csAnalysis.deleteMany({ where: { ticketId: ticket.id } })
  const run = await runAgentCycle(deps, { ticketIds: [ticket.id] })
  return NextResponse.json({ run })
}
