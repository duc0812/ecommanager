import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { CsMessage, CsTicket } from '@/generated/prisma/client'
import type { Llm } from '@/lib/llm/types'
import { withCap } from '@/lib/llm/cap'
import { getCsSettings } from '@/lib/cs/settings'
import { CS_SENTIMENTS } from '@/lib/cs/triage'
import { RUBRIC, REVIEW_SYSTEM, buildReviewUser } from '@/lib/cs/review-prompt'
import { isAgentReply, isStaffReply } from '@/lib/cs/performance'
import { buildOrderContext } from '@/lib/cs/order-context'

export { RUBRIC, RUBRIC_LABELS } from '@/lib/cs/review-prompt'

export const ReviewSchema = z.object({
  messageSentiments: z.array(z.object({ messageId: z.string(), sentiment: z.enum(CS_SENTIMENTS) })),
  replies: z.array(z.object({ messageId: z.string(), score: z.number().int().min(1).max(5), issues: z.array(z.enum(RUBRIC)), reason: z.string(), rewrite: z.string().nullable() })),
  ticketVerdict: z.enum(['RESOLVED', 'UNRESOLVED', 'UNCLEAR']),
  verdictNote: z.string(),
})
export type Review = z.infer<typeof ReviewSchema>

const QUIET_HOURS = 48
const SLOW_HOURS = 24

export function reviewDue(t: Pick<CsTicket, 'fdStatus' | 'reviewedAt' | 'lastCustomerAt' | 'lastReplyAt'>, lastReplyAtAny: Date | null, now: Date): boolean {
  if (!lastReplyAtAny) return false
  if (t.reviewedAt && lastReplyAtAny > t.reviewedAt) return true
  if (t.reviewedAt) return false
  if (t.fdStatus === 4 || t.fdStatus === 5) return true
  const last = Math.max(t.lastCustomerAt?.getTime() ?? 0, lastReplyAtAny.getTime())
  return now.getTime() - last >= QUIET_HOURS * 3600_000
}

export const isReviewable = (m: Pick<CsMessage, 'author' | 'private' | 'source'>) => isStaffReply(m) || isAgentReply(m)

const fmtDateTime = (d: Date) => `${d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toISOString().slice(11, 16)}`

export function formatThreadForReview(messages: CsMessage[]): string {
  return messages
    .filter(m => !m.private)
    .map(m => `[${m.author} ${m.id} ${fmtDateTime(m.createdAt)}${m.author === 'STAFF' && m.source === 'DRAFT_UNCHANGED' ? ' (agent draft sent as-is)' : ''}]\n${m.bodyText.trim() || '(empty)'}`)
    .join('\n\n')
}

export function slowIssues(messages: CsMessage[], messageId: string): string[] {
  const reply = messages.find(m => m.id === messageId)
  if (!reply) return []
  const customerBefore = [...messages].reverse().find(m => m.author === 'CUSTOMER' && m.createdAt < reply.createdAt)
  if (!customerBefore) return []
  const earlierReply = messages.find(m => isReviewable(m) && m.createdAt > customerBefore.createdAt && m.createdAt < reply.createdAt)
  if (earlierReply) return []
  return reply.createdAt.getTime() - customerBefore.createdAt.getTime() > SLOW_HOURS * 3600_000 ? ['TOO_SLOW'] : []
}

export async function applyReview(ticket: CsTicket & { messages: CsMessage[] }, review: Review, model: string, now: Date): Promise<{ reviews: number }> {
  const reviewable = new Set(ticket.messages.filter(isReviewable).map(m => m.id))
  const customers = new Set(ticket.messages.filter(m => m.author === 'CUSTOMER').map(m => m.id))
  let reviews = 0
  for (const s of review.messageSentiments) {
    if (!customers.has(s.messageId)) continue
    await prisma.csMessage.update({ where: { id: s.messageId }, data: { sentiment: s.sentiment } })
  }
  for (const r of review.replies) {
    if (!reviewable.has(r.messageId)) continue
    const issues = Array.from(new Set([...r.issues, ...slowIssues(ticket.messages, r.messageId)]))
    const data = { ticketId: ticket.id, score: r.score, issues: JSON.stringify(issues), reason: r.reason, rewrite: r.rewrite, model, runAt: now }
    await prisma.csReplyReview.upsert({ where: { messageId: r.messageId }, create: { ...data, messageId: r.messageId }, update: data })
    reviews += 1
  }
  await prisma.csTicket.update({ where: { id: ticket.id }, data: { reviewedAt: now, reviewSeq: ticket.reviewSeq + 1 } })
  return { reviews }
}

export async function reviewTicket(ticketId: string, deps: { llm: Llm; now?: Date }): Promise<{ reviews: number }> {
  const now = deps.now ?? new Date()
  const settings = await getCsSettings()
  const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
  const order = await buildOrderContext({ subject: ticket.subject, texts: ticket.messages.filter(m => m.author === 'CUSTOMER').map(m => m.bodyText), cfOrderId: ticket.orderNumber, email: ticket.requesterEmail })
  const orderText = order.order ? `${order.order.shopifyOrderNumber} placed ${fmtDateTime(order.order.placedAt)} · ${order.order.factoryState} · ${order.order.lines.map(l => `${l.qty}× ${l.title}`).join('; ')} · tracking ${order.order.shipments.map(s => `${s.trackingNumber ?? '—'} ${s.status}`).join('; ') || 'none'}` : null
  const user = buildReviewUser({ ticket, thread: formatThreadForReview(ticket.messages), order: orderText })
  const model = settings.reviewModel ?? settings.model
  const { output } = await withCap(settings.llmDailyCallCap, () => deps.llm.complete<Review>({ system: REVIEW_SYSTEM, user, model, schema: ReviewSchema, schemaName: 'cs_review' }), now)
  return applyReview(ticket, output, model, now)
}

export async function pendingReviews(limit: number, now: Date): Promise<string[]> {
  const candidates = await prisma.csTicket.findMany({
    where: { messages: { some: { author: { in: ['STAFF', 'AGENT'] }, private: false } } },
    orderBy: { lastCustomerAt: 'asc' },
    select: { id: true, fdStatus: true, reviewedAt: true, lastCustomerAt: true, lastReplyAt: true, messages: { where: { private: false, author: { in: ['STAFF', 'AGENT'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
    take: 200,
  })
  return candidates.filter(t => reviewDue(t, t.messages[0]?.createdAt ?? null, now)).slice(0, limit).map(t => t.id)
}
