import { prisma } from '@/lib/db'
import type { CsAnalysis, CsCase, CsMessage, CsReplyReview, CsTicket } from '@/generated/prisma/client'
import { buildOrderContext, type OrderContext } from '@/lib/cs/order-context'

export type TicketTab = 'todo' | 'agent' | 'done'

export type TicketRow = {
  id: string
  fdTicketId: number
  subject: string
  requesterEmail: string | null
  requesterName: string | null
  orderNumber: string | null
  category: string | null
  urgency: string | null
  sentiment: string | null
  needsHuman: boolean
  autoReplied: boolean
  fdStatus: number
  lastCustomerAt: Date | null
  lastReplyAt: Date | null
  summary: string | null
  hoursUnanswered: number
}

const URGENCY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 }

function whereFor(tab: TicketTab) {
  if (tab === 'agent') return { autoReplied: true, needsHuman: false, resolvedInTool: false, fdStatus: { notIn: [4, 5] } }
  if (tab === 'done') return { OR: [{ resolvedInTool: true }, { fdStatus: { in: [4, 5] } }] }
  return { needsHuman: true, resolvedInTool: false, fdStatus: { notIn: [4, 5] } }
}

export function hoursUnansweredOf(t: Pick<CsTicket, 'lastCustomerAt' | 'lastReplyAt'>, now: Date): number {
  if (!t.lastCustomerAt) return 0
  if (t.lastReplyAt && t.lastReplyAt >= t.lastCustomerAt) return 0
  return Math.max(0, Math.round(((now.getTime() - t.lastCustomerAt.getTime()) / 3600_000) * 10) / 10)
}

export async function listTickets(tab: TicketTab, q?: string, now = new Date()): Promise<TicketRow[]> {
  const term = q?.trim()
  const search = term
    ? { OR: [{ orderNumber: { contains: term } }, { requesterEmail: { contains: term } }, { subject: { contains: term } }, { requesterName: { contains: term } }] }
    : {}
  const tickets = await prisma.csTicket.findMany({
    where: { AND: [whereFor(tab), search] },
    include: { analyses: { orderBy: { runAt: 'desc' }, take: 1, select: { summary: true } } },
    orderBy: { lastCustomerAt: 'asc' },
    take: 500,
  })
  const rows = tickets.map(t => ({
    id: t.id,
    fdTicketId: t.fdTicketId,
    subject: t.subject,
    requesterEmail: t.requesterEmail,
    requesterName: t.requesterName,
    orderNumber: t.orderNumber,
    category: t.category,
    urgency: t.urgency,
    sentiment: t.sentiment,
    needsHuman: t.needsHuman,
    autoReplied: t.autoReplied,
    fdStatus: t.fdStatus,
    lastCustomerAt: t.lastCustomerAt,
    lastReplyAt: t.lastReplyAt,
    summary: t.analyses[0]?.summary ?? null,
    hoursUnanswered: hoursUnansweredOf(t, now),
  }))
  if (tab === 'todo') {
    rows.sort((a, b) => {
      const ra = URGENCY_RANK[a.urgency ?? ''] ?? 9
      const rb = URGENCY_RANK[b.urgency ?? ''] ?? 9
      if (ra !== rb) return ra - rb
      return (a.lastCustomerAt?.getTime() ?? 0) - (b.lastCustomerAt?.getTime() ?? 0)
    })
  } else {
    rows.sort((a, b) => (b.lastCustomerAt?.getTime() ?? 0) - (a.lastCustomerAt?.getTime() ?? 0))
  }
  return rows
}

export type TicketDetail = {
  ticket: CsTicket
  messages: CsMessage[]
  analysis: CsAnalysis | null
  order: OrderContext
  cases: Pick<CsCase, 'id' | 'title'>[]
  reviews: CsReplyReview[]
}

export async function ticketDetail(id: string): Promise<TicketDetail | null> {
  const ticket = await prisma.csTicket.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } }, analyses: { orderBy: { runAt: 'desc' }, take: 1 } },
  })
  if (!ticket) return null
  const { messages, analyses, ...rest } = ticket
  const analysis = analyses[0] ?? null
  const order = await buildOrderContext({
    subject: ticket.subject,
    texts: messages.filter(m => m.author === 'CUSTOMER').map(m => m.bodyText),
    cfOrderId: ticket.orderNumber,
    email: ticket.requesterEmail,
  })
  const citedIds: string[] = analysis ? (() => { try { return JSON.parse(analysis.citedCaseIds) } catch { return [] } })() : []
  const cases = citedIds.length ? await prisma.csCase.findMany({ where: { id: { in: citedIds } }, select: { id: true, title: true } }) : []
  const reviews = await prisma.csReplyReview.findMany({ where: { ticketId: id } })
  return { ticket: rest as CsTicket, messages, analysis, order, cases, reviews }
}
