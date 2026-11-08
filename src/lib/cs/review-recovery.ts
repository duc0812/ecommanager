import { prisma } from '@/lib/db'
import type { CsReview } from '@/generated/prisma/client'
import type { JmReview, JudgemeClient } from '@/lib/cs/judgeme'
import type { Llm } from '@/lib/llm/types'
import { withCap } from '@/lib/llm/cap'
import { getCsSettings } from '@/lib/cs/settings'
import { buildOrderContext } from '@/lib/cs/order-context'
import { buildReviewSystemPrompt, buildReviewUserPrompt, guardDraft, ReviewDraftSchema, type ReviewDraft } from '@/lib/cs/review-recovery-prompt'

const PER_PAGE = 50
const MAX_PAGES = 10
const SHIPPING_PROTECTION = /shipping protection/i
const ADD_ON = /shipping protection|add[- ]?on|^tip\b|custom text/i

const skuParent = (sku: string | null | undefined) => (sku ?? '').split('-')[0].trim().toUpperCase()
const titleCodes = (title: string | null | undefined): string[] => Array.from((title ?? '').toUpperCase().match(/\b[A-Z]{2}\d{6,}\b/g) ?? [])

// Newest 1★ reviews first; a page made only of reviews already stored means the rest are older and stored too.
export async function syncReviews(client: Pick<JudgemeClient, 'listReviews'>, now = new Date()): Promise<{ added: number }> {
  let added = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const reviews = await client.listReviews({ rating: 1, page, perPage: PER_PAGE })
    if (!reviews.length) break
    let fresh = 0
    for (const r of reviews) {
      const existing = await prisma.csReview.findUnique({ where: { judgemeId: r.id }, select: { id: true } })
      const data = fieldsOf(r)
      if (existing) await prisma.csReview.update({ where: { id: existing.id }, data })
      else { await prisma.csReview.create({ data: { judgemeId: r.id, ...data, createdAt: now } }); fresh++ }
    }
    added += fresh
    if (!fresh) break
  }
  return { added }
}

function fieldsOf(r: JmReview) {
  return {
    rating: r.rating, title: r.title, body: r.body, productExternalId: r.productExternalId, productTitle: r.productTitle,
    reviewerEmail: r.reviewerEmail, reviewerName: r.reviewerName, verified: r.verified, hidden: r.hidden, reviewCreatedAt: r.createdAt,
  }
}

type MatchResult = { orderNumber: string; lineId: string } | { orderNumber: null; reason: string }

export async function matchReview(r: Pick<CsReview, 'reviewerEmail' | 'productExternalId' | 'productTitle' | 'reviewCreatedAt'>): Promise<MatchResult> {
  const email = r.reviewerEmail?.trim().toLowerCase()
  if (!email) return { orderNumber: null, reason: 'Review không có email người viết, không xác định được khách' }
  const orders = (await prisma.order.findMany({
    where: { placedAt: { lte: r.reviewCreatedAt }, customerEmail: { contains: email } },
    select: { shopifyOrderNumber: true, customerEmail: true, placedAt: true, lines: { select: { id: true, sku: true, productTitle: true, shopifyProductId: true, linePosition: true }, orderBy: { linePosition: 'asc' } } },
    orderBy: { placedAt: 'desc' },
  })).filter(o => o.customerEmail?.trim().toLowerCase() === email)
  if (!orders.length) return { orderNumber: null, reason: `Không có đơn nào của ${email} trước ngày review` }

  if (SHIPPING_PROTECTION.test(r.productTitle ?? '')) {
    const o = orders[0]
    const line = o.lines.find(l => (l.sku ?? '').trim() && !ADD_ON.test(l.productTitle))
    return line ? { orderNumber: o.shopifyOrderNumber, lineId: line.id } : { orderNumber: null, reason: 'Review trên Shipping protection nhưng đơn gần nhất không có sản phẩm thật' }
  }
  const productId = r.productExternalId ? `/${r.productExternalId}` : null
  const codes = titleCodes(r.productTitle)
  for (const o of orders) {
    const byId = productId ? o.lines.find(l => l.shopifyProductId?.endsWith(productId)) : undefined
    const byCode = byId ?? o.lines.find(l => codes.includes(skuParent(l.sku)))
    if (byCode) return { orderNumber: o.shopifyOrderNumber, lineId: byCode.id }
  }
  return { orderNumber: null, reason: `Không có đơn nào của ${email} chứa sản phẩm "${r.productTitle ?? r.productExternalId ?? '?'}"` }
}

export async function draftForReview(reviewId: string, deps: { llm: Llm; now?: Date }): Promise<ReviewDraft & { blocked: string | null }> {
  const now = deps.now ?? new Date()
  const review = await prisma.csReview.findUniqueOrThrow({ where: { id: reviewId } })
  const settings = await getCsSettings()
  const ctx = await buildOrderContext({ subject: '', texts: [], cfOrderId: review.orderNumber, email: review.reviewerEmail })
  const order = ctx.order
  const refunded = order ? (await prisma.order.findUnique({ where: { id: order.id }, select: { refundedAmount: true } }))?.refundedAmount ?? 0 : 0
  const reviewedLine = SHIPPING_PROTECTION.test(review.productTitle ?? '') ? order?.lines.find(l => !ADD_ON.test(l.title))?.title ?? null : review.productTitle
  const { output } = await withCap(settings.llmDailyCallCap, () => deps.llm.complete<ReviewDraft>({
    system: buildReviewSystemPrompt(),
    user: buildReviewUserPrompt({ review, order, reviewedLine, refunded }),
    model: settings.model,
    schema: ReviewDraftSchema,
    schemaName: 'review_draft',
  }), now)
  await prisma.csReview.update({ where: { id: reviewId }, data: { caseType: output.caseType, draftSubject: output.subject, draftBody: output.body } })
  return { ...output, blocked: guardDraft(output.body) }
}
