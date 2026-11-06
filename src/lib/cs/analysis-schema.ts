import { z } from 'zod'
import { CS_CATEGORIES, CS_SENTIMENTS, CS_URGENCIES } from '@/lib/cs/triage'
import { TASK_TYPES } from '@/lib/cs/task-labels'

export const AnalysisSchema = z.object({
  category: z.enum(CS_CATEGORIES),
  urgency: z.enum(CS_URGENCIES),
  sentiment: z.enum(CS_SENTIMENTS),
  orderNumber: z.string().nullable(),
  summary: z.string(),
  facts: z.array(z.string()),
  proposal: z.string(),
  citedCaseIds: z.array(z.string()),
  draftReply: z.string().nullable(),
  needsHuman: z.boolean(),
  needsHumanReason: z.string(),
  autoReplyEligible: z.boolean(),
  autoReplyReason: z.string(),
  humanRequested: z.boolean(),
  tasks: z.array(z.object({ type: z.enum(TASK_TYPES), detail: z.string(), amount: z.number().nullable() })),
})

export type Analysis = z.infer<typeof AnalysisSchema>
