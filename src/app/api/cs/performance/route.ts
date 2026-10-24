import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computePerformance } from '@/lib/cs/performance'
import { parsePeriod } from '@/lib/cs/insights'
import { isAgentReply, isStaffReply } from '@/lib/cs/performance'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const period = parsePeriod(req.nextUrl.searchParams)
  const metrics = await computePerformance(period)
  const reviews = await prisma.csReplyReview.findMany({
    where: { ticket: { messages: { some: { author: 'CUSTOMER', createdAt: { gte: period.from, lte: period.to } } } } },
    include: { ticket: { select: { fdTicketId: true, subject: true } } },
    orderBy: { score: 'asc' },
  })
  const messages = await prisma.csMessage.findMany({ where: { id: { in: reviews.map(r => r.messageId) } }, select: { id: true, bodyText: true, author: true, source: true, private: true, createdAt: true } })
  const byId = new Map(messages.map(m => [m.id, m]))
  const reviewRows = reviews.map(r => {
    const m = byId.get(r.messageId)
    const who = m ? (isStaffReply(m) ? 'STAFF' : isAgentReply(m) ? 'AGENT' : 'OTHER') : 'OTHER'
    return { id: r.id, ticketId: r.ticketId, fdTicketId: r.ticket.fdTicketId, subject: r.ticket.subject, who, source: m?.source ?? null, at: m?.createdAt ?? r.runAt, score: r.score, issues: JSON.parse(r.issues) as string[], reason: r.reason, rewrite: r.rewrite, quote: (m?.bodyText ?? '').slice(0, 400) }
  })
  const staffReviews = reviewRows.filter(r => r.who === 'STAFF')
  const scoreHistogram = [0, 0, 0, 0, 0]
  const issueCounts: Record<string, number> = {}
  for (const r of staffReviews) {
    if (r.score >= 1 && r.score <= 5) scoreHistogram[r.score - 1] += 1
    for (const i of r.issues) if (i !== 'GOOD') issueCounts[i] = (issueCounts[i] ?? 0) + 1
  }
  const reports = await prisma.csPerformanceReport.findMany({ orderBy: { createdAt: 'desc' }, take: 12 })
  return NextResponse.json({ period, metrics, scoreHistogram, issueCounts, reviews: reviewRows, reports })
}
