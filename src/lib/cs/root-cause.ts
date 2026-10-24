import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { CsAnalysis, CsTicket } from '@/generated/prisma/client'
import type { Llm } from '@/lib/llm/types'
import { getCsSettings } from '@/lib/cs/settings'
import { withCap } from '@/lib/llm/cap'
import { buildOrderTimeline, formatTimeline, type OrderTimeline } from '@/lib/cs/timeline'
import { buildRootCausePrompt, ISSUE_TYPES, STAGES } from '@/lib/cs/root-cause-prompt'
import type { CsCategory } from '@/lib/cs/triage'

export { STAGES, ISSUE_TYPES, buildRootCausePrompt } from '@/lib/cs/root-cause-prompt'

export const PROBLEM_CATEGORIES: CsCategory[] = ['DAMAGED_OR_DEFECTIVE', 'WRONG_ITEM', 'MISSING_ITEM', 'DELIVERED_NOT_RECEIVED', 'REFUND_REQUEST', 'PERSONALIZATION_ISSUE', 'ADDRESS_CHANGE', 'ORDER_STATUS']

export const RootCauseSchema = z.object({
  stage: z.enum(STAGES),
  issueType: z.enum(ISSUE_TYPES),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  evidence: z.string(),
  affectedLineIds: z.array(z.string()),
})
export type RootCause = z.infer<typeof RootCauseSchema>

export function needsInvestigation(a: Pick<CsAnalysis, 'category' | 'rootCauseAt'>, ticket: Pick<CsTicket, 'orderMatch'>, timeline: OrderTimeline | null): 'RUN' | 'UNKNOWN' | 'SKIP' {
  if (a.rootCauseAt) return 'SKIP'
  if (!PROBLEM_CATEGORIES.includes(a.category as CsCategory)) return 'SKIP'
  const matched = ticket.orderMatch === 'EXACT' || ticket.orderMatch === 'BY_EMAIL'
  if (!matched || !timeline) return 'UNKNOWN'
  if (a.category === 'ORDER_STATUS' && !timeline.gaps.some(g => g.late)) return 'SKIP'
  return 'RUN'
}

const fmtDateTime = (d: Date) => `${d.toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toISOString().slice(11, 16)}`

export async function investigateTicket(ticketId: string, deps: { llm: Llm; now?: Date }): Promise<CsAnalysis> {
  const now = deps.now ?? new Date()
  const ticket = await prisma.csTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { messages: { orderBy: { createdAt: 'asc' } }, analyses: { orderBy: { runAt: 'desc' }, take: 1 } } })
  const analysis = ticket.analyses[0]
  if (!analysis) throw new Error(`ticket ${ticketId} has no analysis to investigate`)
  const settings = await getCsSettings()
  const timeline = ticket.orderId ? await buildOrderTimeline(ticket.orderId, settings, now) : null
  const decision = needsInvestigation(analysis, ticket, timeline)
  if (decision === 'SKIP') {
    if (analysis.rootCauseAt || !PROBLEM_CATEGORIES.includes(analysis.category as CsCategory)) return analysis
    return prisma.csAnalysis.update({ where: { id: analysis.id }, data: { rootCauseAt: now } })
  }
  if (decision === 'UNKNOWN') {
    return prisma.csAnalysis.update({ where: { id: analysis.id }, data: { rootCauseStage: 'UNKNOWN', rootCauseConfidence: 'LOW', issueType: 'OTHER', rootCauseEvidence: 'Không tìm thấy đơn trong tool nên không dựng được timeline.', rootCauseAt: now } })
  }
  const thread = ticket.messages
    .filter(m => !m.private)
    .map(m => `[${m.author} ${fmtDateTime(m.createdAt)}]\n${m.bodyText.trim() || '(empty)'}`)
    .join('\n\n')
  const { system, user } = buildRootCausePrompt({ thread, timeline: formatTimeline(timeline!), category: analysis.category as CsCategory, summary: analysis.summary })
  const { output } = await withCap(settings.llmDailyCallCap, () => deps.llm.complete<RootCause>({ system, user, model: settings.reviewModel ?? settings.model, schema: RootCauseSchema, schemaName: 'root_cause' }), now)
  const fixed = coerceLateIssue(output, timeline!)
  return prisma.csAnalysis.update({
    where: { id: analysis.id },
    data: { rootCauseStage: fixed.stage, issueType: fixed.issueType, rootCauseConfidence: fixed.confidence, rootCauseEvidence: fixed.evidence, affectedLineIds: JSON.stringify(fixed.affectedLineIds), rootCauseAt: now },
  })
}

const LATE_GAP: Record<string, string> = { LATE_DESIGN: 'design', LATE_HANDOFF: 'handoff', LATE_PRODUCTION: 'production', LATE_SHIPPING: 'transit' }

export function coerceLateIssue(o: RootCause, timeline: OrderTimeline): RootCause {
  const gap = LATE_GAP[o.issueType]
  if (!gap) return o
  const supported = timeline.gaps.some(g => (g.name === gap || (gap === 'transit' && g.name === 'stalled')) && g.late)
  if (supported) return o
  return { ...o, issueType: 'OTHER', confidence: 'LOW', evidence: `${o.evidence}\n(Model chọn ${o.issueType} nhưng timeline không có khâu nào trễ tương ứng — đã hạ xuống OTHER.)` }
}

export async function pendingInvestigations(limit: number): Promise<string[]> {
  const rows = await prisma.csAnalysis.findMany({
    where: { rootCauseAt: null, category: { in: PROBLEM_CATEGORIES }, ticket: { fdStatus: { notIn: [4, 5] }, resolvedInTool: false } },
    orderBy: { runAt: 'asc' },
    select: { ticketId: true, id: true },
    take: limit * 3,
  })
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (seen.has(r.ticketId)) continue
    seen.add(r.ticketId)
    const newest = await prisma.csAnalysis.findFirst({ where: { ticketId: r.ticketId }, orderBy: { runAt: 'desc' }, select: { id: true } })
    if (newest?.id !== r.id) {
      await prisma.csAnalysis.update({ where: { id: r.id }, data: { rootCauseAt: new Date() } })
      continue
    }
    out.push(r.ticketId)
    if (out.length >= limit) break
  }
  return out
}
