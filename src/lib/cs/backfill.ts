import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { LlmCapReached, withCap } from '@/lib/llm/cap'
import { getCsSettings } from '@/lib/cs/settings'
import { CS_CATEGORIES, CS_SENTIMENTS, CS_URGENCIES } from '@/lib/cs/triage'
import { RootCauseSchema, investigateTicket } from '@/lib/cs/root-cause'
import { ReviewSchema, applyReview, formatThreadForReview, isReviewable, reviewTicket } from '@/lib/cs/review'
import { REVIEW_SYSTEM, buildReviewUser } from '@/lib/cs/review-prompt'
import { buildRootCausePrompt } from '@/lib/cs/root-cause-prompt'
import { buildOrderTimeline, formatTimeline } from '@/lib/cs/timeline'

export const CombinedBackfillSchema = z.object({
  category: z.enum(CS_CATEGORIES),
  urgency: z.enum(CS_URGENCIES),
  sentiment: z.enum(CS_SENTIMENTS),
  summary: z.string(),
  proposal: z.string(),
  rootCause: RootCauseSchema,
  review: ReviewSchema,
})
export type CombinedBackfill = z.infer<typeof CombinedBackfillSchema>

const PROGRESS_KEY = 'last_cs_review_backfill'

const COMBINED_SYSTEM = `${REVIEW_SYSTEM}

## Additional task: this ticket was never triaged or investigated
Also return: category (one of ${CS_CATEGORIES.join(', ')}), urgency (LOW/NORMAL/HIGH/URGENT), sentiment (overall), summary and proposal in Vietnamese (≤3 lines each), and rootCause using the stage rules below. Use UNKNOWN when the timeline block is missing.

${buildRootCausePrompt({ thread: '', timeline: '', category: 'OTHER', summary: '' }).system}`

async function remainingCount(): Promise<number> {
  return prisma.csTicket.count({ where: { reviewedAt: null, messages: { some: { author: { in: ['STAFF', 'AGENT'] }, private: false } } } })
}

export async function runReviewBackfill(deps: { llm: Llm; now?: Date; maxCalls?: number }): Promise<{ processed: number; remaining: number; capReached: boolean }> {
  const now = deps.now ?? new Date()
  const settings = await getCsSettings()
  const model = settings.reviewModel ?? settings.model
  const limit = deps.maxCalls ?? 20
  let processed = 0
  let capReached = false

  const candidates = await prisma.csTicket.findMany({
    where: { reviewedAt: null, messages: { some: { author: { in: ['STAFF', 'AGENT'] }, private: false } } },
    orderBy: { lastCustomerAt: 'asc' },
    take: limit,
    include: { messages: { orderBy: { createdAt: 'asc' } }, analyses: { orderBy: { runAt: 'desc' }, take: 1 } },
  })

  for (const t of candidates) {
    if (!t.messages.some(isReviewable)) {
      await prisma.csTicket.update({ where: { id: t.id }, data: { reviewedAt: now } })
      continue
    }
    try {
      if (t.analyses[0]) {
        await reviewTicket(t.id, { llm: deps.llm, now })
        if (!t.analyses[0].rootCauseAt) await withCap(settings.llmDailyCallCap, () => investigateTicket(t.id, { llm: deps.llm, now }), now).catch(err => { if (err instanceof LlmCapReached) throw err })
      } else {
        const timeline = t.orderId ? await buildOrderTimeline(t.orderId, settings, now) : null
        const user = `${buildReviewUser({ ticket: t, thread: formatThreadForReview(t.messages), order: null })}

# Order timeline
${timeline ? formatTimeline(timeline) : '(no order matched — rootCause must be UNKNOWN)'}`
        const { output } = await withCap(settings.llmDailyCallCap, () => deps.llm.complete<CombinedBackfill>({ system: COMBINED_SYSTEM, user, model, schema: CombinedBackfillSchema, schemaName: 'cs_combined' }), now)
        const stage = timeline ? output.rootCause.stage : 'UNKNOWN'
        await prisma.csAnalysis.create({
          data: {
            ticketId: t.id, model, inputHash: `backfill-${t.id}`, outputJson: JSON.stringify(output), category: output.category, urgency: output.urgency, sentiment: output.sentiment,
            summary: output.summary, proposal: output.proposal, needsHuman: false, autoReplyEligible: false, gateJson: JSON.stringify({ allowed: false, reasons: ['backfill'] }),
            rootCauseStage: stage, issueType: output.rootCause.issueType, rootCauseConfidence: timeline ? output.rootCause.confidence : 'LOW', rootCauseEvidence: output.rootCause.evidence,
            affectedLineIds: JSON.stringify(output.rootCause.affectedLineIds), rootCauseAt: now,
          },
        })
        await prisma.csTicket.update({ where: { id: t.id }, data: { category: output.category, urgency: output.urgency, sentiment: output.sentiment, lastAnalysisAt: now, needsHuman: t.fdStatus === 4 || t.fdStatus === 5 ? false : t.needsHuman } })
        await applyReview(t, output.review, model, now)
      }
      processed += 1
    } catch (err) {
      if (err instanceof LlmCapReached) { capReached = true; break }
      throw err
    }
  }

  const remaining = await remainingCount()
  const value = JSON.stringify({ ranAt: now.toISOString(), processed, remaining, capReached })
  await prisma.appSetting.upsert({ where: { key: PROGRESS_KEY }, create: { key: PROGRESS_KEY, value }, update: { value } })
  return { processed, remaining, capReached }
}
