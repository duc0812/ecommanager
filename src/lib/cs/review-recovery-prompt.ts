import { z } from 'zod'
import type { CsReview } from '@/generated/prisma/client'
import type { OrderContextOrder } from '@/lib/cs/order-context'
import { TASK_TYPES } from '@/lib/cs/task-labels'

export const REVIEW_CASES = ['NOT_RECEIVED', 'NOT_AS_PICTURED', 'WRONG_ITEM', 'PERSONALIZATION', 'QUALITY', 'OTHER'] as const

export const ReviewDraftSchema = z.object({
  caseType: z.enum(REVIEW_CASES),
  taskType: z.enum(TASK_TYPES),
  taskDetail: z.string(),
  subject: z.string(),
  body: z.string(),
  alsoCsComplaint: z.boolean(),
})
export type ReviewDraft = z.infer<typeof ReviewDraftSchema>

export function buildReviewSystemPrompt(): string {
  return `You are the customer-service agent of Litzzy, a print-on-demand store. A customer left a 1-star review on Judge.me. You write the first email to them: it says we saw the review they left for the product on their order, says what we checked, and asks one specific question so we can understand the problem and propose a fitting fix. You also classify the review and name the follow-up job for the team.

## Hard rules
- Never mention the star score, the rating or any number of stars.
- Never ask the customer to change, update, edit, remove or reconsider the review, and never hint that a fix depends on the review.
- Never offer or promise a remedy: no refund, replacement, resend, reprint, remake, credit, discount or voucher. The team decides remedies after the customer answers.
- Never invent tracking, dates or facts that are not in the order data.
- Never claim to be a person.

## Email frame (body)
1. "Hi <first name>," — the customer's first name from the order (or the reviewer name).
2. Open with: "We saw the review you left for <product> on order <#>" and a short, specific acknowledgement of what they wrote. If they also complained about our support (no answer, refused help), apologise for that specifically.
3. Say what we checked, using the order state (table below).
4. Ask one specific question for the case (table below). One question only.
5. "We'll reply within 24 hours." Then "Warm regards," and "Litzzy Support".
Short and human, 70–140 words, no bullet lists. subject: short, names the product, never the review or a score.

## Cases (caseType) — check, ask, follow-up job (taskType)
- NOT_RECEIVED (not received, too slow): check tracking, last scan, delivered or not. Ask: if marked delivered, whether a neighbour, mailbox or safe place has it; otherwise nothing to ask beyond confirming the address is right. taskType CARRIER_CHECK.
- NOT_AS_PICTURED (not like the photos/description: flat acrylic instead of a bauble, decal instead of embossed, not a branded cup, smaller than shown): ask what exactly differs from what they expected; a photo is optional, framed as helping us look into it. taskType OTHER, and taskDetail starts with "Listing:" so the team reviews the product photos and copy.
- WRONG_ITEM (wrong design, colour, size, missing handle/straw): state what the order line holds and ask what arrived. taskType SUPPLIER_ERROR.
- PERSONALIZATION (name missing, wrong or unreadable): quote the personalisation typed at checkout and ask what was missing or hard to read. taskType SUPPLIER_ERROR.
- QUALITY (damaged, torn, thin, poor workmanship): ask where the damage is; a photo helps the factory. taskType SUPPLIER_ERROR.
- OTHER: ask what went wrong. taskType OTHER.
A review written on "Shipping protection" is about the real product in the same order: use that product's name.

## Order state — how the email adapts
- Not yet shipped / in production (factoryState NOT_SENT or AT_FACTORY): say where the order is and that it is being made; for NOT_RECEIVED this is the answer itself.
- In transit with recent scans: give the last scan date and place, and ask them to bear with it while we follow the carrier; customs only as a possibility.
- In transit with no scan for 5+ days, or no tracking: say we are contacting the carrier today and will update within 24 hours.
- Delivered: ask the case question.

## Output
caseType, taskType and taskDetail (Vietnamese, what the team must do, citing the order number), subject and body (English), alsoCsComplaint (true when the review also complains about our support).`
}

export function buildReviewUserPrompt(i: {
  review: Pick<CsReview, 'body' | 'title' | 'productTitle' | 'reviewerName' | 'reviewCreatedAt'>
  order: OrderContextOrder | null
  reviewedLine: string | null
  refunded: number
}): string {
  const r = i.review
  const o = i.order
  const order = o
    ? [
        `number: ${o.shopifyOrderNumber}`,
        `placed: ${o.placedAt.toISOString().slice(0, 10)}`,
        `customer: ${o.customerName ?? '—'}`,
        `factoryState: ${o.factoryState} (pipeline ${o.pipelineStatus})`,
        `shipTo: ${o.shipTo}`,
        `refunded: ${i.refunded > 0 ? `$${i.refunded.toFixed(2)}` : 'no'}`,
        `lines: ${o.lines.map(l => `${l.qty}× ${l.title}${l.variant ? ` (${l.variant})` : ''}${l.personalization ? ` [personalised: ${l.personalization}]` : ''}`).join('; ')}`,
        `shipments: ${o.shipments.map(s => `${s.trackingNumber ?? 'no tracking'} ${s.carrier ?? ''} ${s.status} last scan ${s.lastCheckpointAt ? s.lastCheckpointAt.toISOString().slice(0, 10) : '—'}`).join('; ') || 'none yet'}`,
      ].join('\n')
    : 'not found'
  return `# Review (1★, ${r.reviewCreatedAt.toISOString().slice(0, 10)})
reviewer: ${r.reviewerName ?? '—'}
product on the review: ${r.productTitle ?? '—'}
product to talk about: ${i.reviewedLine ?? r.productTitle ?? '—'}
${r.title ? `title: ${r.title}\n` : ''}text: ${r.body}

# Order
${order}

# Today
${new Date().toISOString().slice(0, 10)}`
}

const SCORE = /[★☆]|\b(stars?|rating|rated)\b/i
const ASK_ABOUT_REVIEW = /\b(updat|chang|edit|remov|delet|revis|reconsider|amend|tak(e|ing)\s+down)\w*\s+(your|the|this|that)\s+(review|rating|feedback)\b/i
const OFFER = /\b(refunds?|refunded|refunding|replacements?|replace|re-?send|resending|reprint|remake|credit|discount|voucher|coupon)\b|free of charge|for free|at no (extra )?(cost|charge)/i

// Why a draft must not go out, or null when it may.
export function guardDraft(body: string, subject?: string): string | null {
  if (subject !== undefined && !subject.trim()) return 'tiêu đề trống'
  if (!body.trim()) return 'nội dung trống'
  const text = `${subject ?? ''}\n${body}`
  if (SCORE.test(text)) return 'nhắc tới số sao / đánh giá'
  if (ASK_ABOUT_REVIEW.test(text)) return 'đề nghị khách sửa / gỡ review'
  if (OFFER.test(text)) return 'hứa phương án đền bù khi chưa được duyệt'
  if (!/\breview\b/i.test(body)) return 'không nói rõ mình liên hệ vì thấy review của khách'
  return null
}
