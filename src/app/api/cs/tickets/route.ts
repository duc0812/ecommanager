import { NextRequest, NextResponse } from 'next/server'
import { listTickets, type TicketTab } from '@/lib/cs/queries'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const tab = (req.nextUrl.searchParams.get('tab') ?? 'todo') as TicketTab
  if (!['todo', 'agent', 'done'].includes(tab)) return NextResponse.json({ error: 'tab không hợp lệ' }, { status: 400 })
  const q = req.nextUrl.searchParams.get('q') ?? undefined
  return NextResponse.json({ tickets: await listTickets(tab, q) })
}
