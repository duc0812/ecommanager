import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import type { CsAnalysis, CsMessage } from '@/generated/prisma/client'
import type { Llm } from '@/lib/llm/anthropic'
import { buildOrderContext, type OrderContext } from '@/lib/cs/order-context'
import { buildSystemPrompt, buildUserPrompt } from '@/lib/cs/agent-prompt'
import { getCsSettings } from '@/lib/cs/settings'
import { finalUrgency, ruleUrgency } from '@/lib/cs/triage'
import { autoReplyGate, mentionsRefundAddressOrCancel } from '@/lib/cs/policy'
import { withCap } from '@/lib/llm/cap'
import { effectiveMode, type CsMode } from '@/lib/cs/hours'

export function inputHashFor(messages: Pick<CsMessage, 'id' | 'author'>[], order: OrderContext, directiveIds: string[] = [], mode: CsMode = 'BUSINESS'): string {
  const parts = [
    ...(mode === 'AFTER_HOURS' ? ['AFTER_HOURS'] : []),
    ...directiveIds,
    ...messages.filter(m => m.author === 'CUSTOMER').map(m => m.id),
    order.order ? order.order.id : order.match,
    order.order?.factoryState ?? '',
    ...(order.order?.shipments.map(s => s.status) ?? []),
  ]
  return createHash('sha1').update(parts.join('|')).digest('hex')
}

function startOfToday(now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

export async function analyzeTicket(ticketId: string, deps: { llm: Llm; now?: Date; force?: boolean }): Promise<CsAnalysis> {
  const now = deps.now ?? new Date()
  const ticket = await prisma.csTicket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { messages: { orderBy: { createdAt: 'asc' } }, analyses: { orderBy: { runAt: 'desc' }, take: 3 }, directives: { where: { resolvedAt: null }, orderBy: { createdAt: 'asc' } } },
  })
  const customerTexts = ticket.messages.filter(m => m.author === 'CUSTOMER').map(m => m.bodyText)
  const order = await buildOrderContext({ subject: ticket.subject, texts: customerTexts, cfOrderId: ticket.orderNumber, email: ticket.requesterEmail })
  const settings = await getCsSettings()
  const mode = effectiveMode(now, settings)
  const inputHash = inputHashFor(ticket.messages, order, ticket.directives.map(d => d.id), mode)
  const latest = ticket.analyses[0]
  if (latest && latest.inputHash === inputHash && !deps.force) return latest

  const cases = await prisma.csCase.findMany({ where: { active: true }, orderBy: { updatedAt: 'desc' } })
  const { output, tokensIn, tokensOut } = await withCap(settings.llmDailyCallCap, () => deps.llm.analyze({
    system: buildSystemPrompt(cases, settings),
    user: buildUserPrompt({ ticket, messages: ticket.messages, order, previous: ticket.analyses, directives: ticket.directives, mode }),
    model: settings.model,
  }), now)

  const customerCount = ticket.messages.filter(m => m.author === 'CUSTOMER').length
  const replies = ticket.messages.filter(m => (m.author === 'STAFF' || m.author === 'AGENT' || m.author === 'SYSTEM') && !m.private)
  const lastReplyAt = replies.at(-1)?.createdAt ?? null
  const firstUnanswered = ticket.messages.find(m => m.author === 'CUSTOMER' && (!lastReplyAt || m.createdAt > lastReplyAt))
  const hoursUnanswered = firstUnanswered ? Math.max(0, (now.getTime() - firstUnanswered.createdAt.getTime()) / 3600_000) : 0

  const urgency = finalUrgency(output.urgency, ruleUrgency({ category: output.category, factoryState: order.order?.factoryState ?? null, sentiment: output.sentiment, hoursUnanswered }))

  const [autoRepliesToday, autoRepliesOnTicket24h, activeCases] = await Promise.all([
    prisma.csMessage.count({ where: { author: 'AGENT', createdAt: { gte: startOfToday(now) } } }),
    prisma.csMessage.count({ where: { ticketId, author: 'AGENT', private: false, createdAt: { gte: new Date(now.getTime() - 86400_000) } } }),
    prisma.csCase.count({ where: { active: true, category: output.category } }),
  ])
  const gate = autoReplyGate({
    settings,
    mode,
    category: output.category,
    sentiment: output.sentiment,
    orderMatch: order.match,
    customerMessageCount: customerCount,
    hasAnyReply: replies.length > 0,
    pendingCustomerMessage: !!firstUnanswered,
    hasTracking: !!order.order?.shipments.some(s => s.trackingNumber && s.status !== 'EXPIRED' && s.status !== 'EXCEPTION'),
    placedAt: order.order?.placedAt ?? null,
    now,
    textMentionsRefundAddressOrCancel: mentionsRefundAddressOrCancel([ticket.subject, ...customerTexts].join('\n')),
    autoRepliesToday,
    autoRepliesOnTicket24h,
    openDirectives: ticket.directives.length,
    hasActiveCaseForCategory: activeCases > 0,
  })
  const needsHuman = output.needsHuman || !gate.allowed || !output.draftReply

  const analysis = await prisma.csAnalysis.create({
    data: {
      ticketId,
      model: settings.model,
      inputHash,
      outputJson: JSON.stringify(output),
      category: output.category,
      urgency,
      sentiment: output.sentiment,
      summary: output.summary,
      proposal: output.proposal,
      draftReply: output.draftReply,
      needsHuman,
      citedCaseIds: JSON.stringify(output.citedCaseIds),
      autoReplyEligible: output.autoReplyEligible,
      gateJson: JSON.stringify(gate),
      tokensIn,
      tokensOut,
    },
  })
  await prisma.csTicket.update({
    where: { id: ticketId },
    data: {
      category: output.category,
      urgency,
      sentiment: output.sentiment,
      orderId: order.order?.id ?? null,
      orderNumber: order.order?.shopifyOrderNumber ?? ticket.orderNumber,
      orderMatch: order.match,
      needsHuman: true,
      lastAnalysisAt: now,
    },
  })
  return analysis
}
