import { prisma } from '@/lib/db'
import type { CsMessage, CsTicket } from '@/generated/prisma/client'

export type Period = { from: Date; to: Date }
export type ResponseStats = { count: number; medianH: number | null; meanH: number | null; p90H: number | null; over24hPct: number | null; worst: { ticketId: string; fdTicketId: number; hours: number }[] }
type RepliesPerTicket = { mean: number | null; over3Pct: number | null; over3: { ticketId: string; fdTicketId: number; replies: number }[] }
type SentimentAfterReply = { improved: number; same: number; worse: number; worseItems: { ticketId: string; fdTicketId: number; messageId: string }[] }
export type PerformanceMetrics = {
  period: Period
  tickets: number
  staff: {
    firstResponse: ResponseStats
    nextResponse: ResponseStats
    repliesPerTicket: RepliesPerTicket
    draftUnchanged: number
    prematureCloses: { count: number; closedTickets: number; pct: number | null; items: { ticketId: string; fdTicketId: number; reopenSentiment: string | null }[] }
    sentimentAfterReply: SentimentAfterReply
  }
  agent: { firstResponse: ResponseStats; nextResponse: ResponseStats; repliesPerTicket: RepliesPerTicket; sentimentAfterReply: SentimentAfterReply }
}

const H = 3600_000
const VN_OFFSET = 7 * H
const RANK: Record<string, number> = { CALM: 0, FRUSTRATED: 1, ANGRY: 2, DISPUTE_THREAT: 3 }

export function isStaffReply(m: Pick<CsMessage, 'author' | 'private' | 'source'>): boolean {
  return m.author === 'STAFF' && !m.private && m.source !== 'DRAFT_UNCHANGED'
}
export function isAgentReply(m: Pick<CsMessage, 'author' | 'private' | 'source'>): boolean {
  return !m.private && (m.author === 'AGENT' || (m.author === 'STAFF' && m.source === 'DRAFT_UNCHANGED'))
}

const round1 = (n: number) => Math.round(n * 10) / 10

function stats(samples: { ticketId: string; fdTicketId: number; hours: number }[]): ResponseStats {
  if (!samples.length) return { count: 0, medianH: null, meanH: null, p90H: null, over24hPct: null, worst: [] }
  const sorted = samples.map(s => s.hours).sort((a, b) => a - b)
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]
  return {
    count: samples.length,
    medianH: round1(median),
    meanH: round1(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p90H: round1(p90),
    over24hPct: round1((sorted.filter(h => h > 24).length / sorted.length) * 100),
    worst: [...samples].sort((a, b) => b.hours - a.hours).slice(0, 10),
  }
}

type Loaded = CsTicket & { messages: CsMessage[] }

function responseSamples(tickets: Loaded[], isReply: (m: CsMessage) => boolean, useStats: boolean) {
  const first: { ticketId: string; fdTicketId: number; hours: number }[] = []
  const next: { ticketId: string; fdTicketId: number; hours: number }[] = []
  for (const t of tickets) {
    const msgs = t.messages
    const firstCustomer = msgs.find(m => m.author === 'CUSTOMER')
    if (!firstCustomer) continue
    const firstReply = msgs.find(m => isReply(m) && m.createdAt > firstCustomer.createdAt)
    if (firstReply) {
      const at = useStats && t.fdFirstRespondedAt && t.fdFirstRespondedAt > firstCustomer.createdAt ? t.fdFirstRespondedAt : firstReply.createdAt
      first.push({ ticketId: t.id, fdTicketId: t.fdTicketId, hours: round1((at.getTime() - firstCustomer.createdAt.getTime()) / H) })
    }
    const laterCustomers = msgs.filter(m => m.author === 'CUSTOMER' && m.createdAt > firstCustomer.createdAt)
    for (const c of laterCustomers) {
      const reply = msgs.find(m => isReply(m) && m.createdAt > c.createdAt)
      const nextCustomer = msgs.find(m => m.author === 'CUSTOMER' && m.createdAt > c.createdAt)
      if (reply && (!nextCustomer || reply.createdAt < nextCustomer.createdAt)) next.push({ ticketId: t.id, fdTicketId: t.fdTicketId, hours: round1((reply.createdAt.getTime() - c.createdAt.getTime()) / H) })
    }
  }
  return { first: stats(first), next: stats(next) }
}

function repliesPerTicket(tickets: Loaded[], isReply: (m: CsMessage) => boolean): RepliesPerTicket {
  const counts = tickets.map(t => ({ ticketId: t.id, fdTicketId: t.fdTicketId, replies: t.messages.filter(isReply).length })).filter(c => c.replies > 0)
  if (!counts.length) return { mean: null, over3Pct: null, over3: [] }
  const over3 = counts.filter(c => c.replies > 3)
  return { mean: Math.round((counts.reduce((a, c) => a + c.replies, 0) / counts.length) * 100) / 100, over3Pct: round1((over3.length / counts.length) * 100), over3 }
}

function sentimentAfter(tickets: Loaded[], isReply: (m: CsMessage) => boolean): SentimentAfterReply {
  const out: SentimentAfterReply = { improved: 0, same: 0, worse: 0, worseItems: [] }
  for (const t of tickets) {
    const msgs = t.messages
    for (const r of msgs.filter(isReply)) {
      const before = [...msgs].reverse().find(m => m.author === 'CUSTOMER' && m.createdAt < r.createdAt && m.sentiment)
      const after = msgs.find(m => m.author === 'CUSTOMER' && m.createdAt > r.createdAt && m.sentiment)
      if (!before || !after) continue
      const diff = (RANK[after.sentiment!] ?? 0) - (RANK[before.sentiment!] ?? 0)
      if (diff < 0) out.improved += 1
      else if (diff === 0) out.same += 1
      else { out.worse += 1; out.worseItems.push({ ticketId: t.id, fdTicketId: t.fdTicketId, messageId: r.id }) }
    }
  }
  return out
}

export async function computePerformance(period: Period): Promise<PerformanceMetrics> {
  const tickets = await prisma.csTicket.findMany({
    where: { lastCustomerAt: { not: null }, messages: { some: { author: 'CUSTOMER', createdAt: { gte: period.from, lte: period.to } } } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  const inPeriod = tickets.filter(t => {
    const first = t.messages.find(m => m.author === 'CUSTOMER')
    return first && first.createdAt >= period.from && first.createdAt <= period.to
  })
  const staffResp = responseSamples(inPeriod, isStaffReply, true)
  const agentResp = responseSamples(inPeriod, isAgentReply, false)
  const closedTickets = inPeriod.filter(t => t.fdResolvedAt || t.fdClosedAt || t.closedAt || t.fdStatus === 4 || t.fdStatus === 5)
  const reopened = inPeriod.filter(t => t.reopenCount > 0)
  const items = reopened.map(t => {
    const closedAt = t.fdResolvedAt ?? t.fdClosedAt ?? t.closedAt
    const after = closedAt ? t.messages.find(m => m.author === 'CUSTOMER' && m.createdAt > closedAt) : null
    return { ticketId: t.id, fdTicketId: t.fdTicketId, reopenSentiment: after?.sentiment ?? null }
  })
  return {
    period,
    tickets: inPeriod.length,
    staff: {
      firstResponse: staffResp.first,
      nextResponse: staffResp.next,
      repliesPerTicket: repliesPerTicket(inPeriod, isStaffReply),
      draftUnchanged: inPeriod.reduce((n, t) => n + t.messages.filter(m => m.author === 'STAFF' && !m.private && m.source === 'DRAFT_UNCHANGED').length, 0),
      prematureCloses: { count: reopened.length, closedTickets: closedTickets.length, pct: closedTickets.length ? round1((reopened.length / closedTickets.length) * 100) : null, items },
      sentimentAfterReply: sentimentAfter(inPeriod, isStaffReply),
    },
    agent: {
      firstResponse: agentResp.first,
      nextResponse: agentResp.next,
      repliesPerTicket: repliesPerTicket(inPeriod, isAgentReply),
      sentimentAfterReply: sentimentAfter(inPeriod, isAgentReply),
    },
  }
}

export function weekBounds(now: Date, offsetWeeks = 0): Period {
  const vn = new Date(now.getTime() + VN_OFFSET)
  const dow = (vn.getUTCDay() + 6) % 7
  const mondayVn = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - dow) + offsetWeeks * 7 * 86400_000
  const from = new Date(mondayVn - VN_OFFSET)
  const to = new Date(from.getTime() + 7 * 86400_000 - 1)
  return { from, to }
}
