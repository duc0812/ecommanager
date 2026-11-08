import { prisma } from '@/lib/db'
import type { CsReview } from '@/generated/prisma/client'
import type { JmReview, JudgemeClient } from '@/lib/cs/judgeme'
import type { Llm } from '@/lib/llm/types'
import { withCap } from '@/lib/llm/cap'
import { getCsSettings } from '@/lib/cs/settings'
import { buildOrderContext } from '@/lib/cs/order-context'
import { openTask } from '@/lib/cs/tasks'
import { TASK_META } from '@/lib/cs/task-labels'
import type { OutboundPayload } from '@/lib/cs/custom-verify'
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

const REVIEW_TAG = 'em-review-1star'
const TICKET_WINDOW_DAYS = 90
const OPEN_TASK = ['NEW', 'IN_PROGRESS', 'WAITING']

type ProcessDeps = {
  llm: Llm | null
  fd: { outboundEmail(p: OutboundPayload): Promise<{ id: number }> }
  fdLookup: { ticketsByEmail(email: string): Promise<{ id: number; created_at: string }[]> }
  now?: Date
}

const quote = (r: Pick<CsReview, 'body' | 'productTitle' | 'reviewerName' | 'reviewerEmail'>) =>
  `Review 1★ của ${r.reviewerName ?? r.reviewerEmail ?? 'khách'} cho "${r.productTitle ?? '?'}": "${r.body.slice(0, 300)}"`

async function park(review: CsReview, orderNumber: string | null, reason: string, now: Date): Promise<void> {
  const task = await openTask({ ticketId: null, orderNumber, type: 'REVIEW_RECOVERY', detail: `${quote(review)}\nTẠM GIỮ, không gửi email: ${reason}. Chờ chủ shop chỉ đạo.`, source: 'AGENT', actor: null, reviewId: review.id }, now)
  await prisma.csReview.update({ where: { id: review.id }, data: { status: 'PARKED', orderNumber, matchNote: reason, taskId: task.id } })
}

async function send(review: CsReview, emailConfigId: number, fd: ProcessDeps['fd'], now: Date): Promise<void> {
  const email = review.reviewerEmail!
  const sent = await fd.outboundEmail({
    email, subject: review.draftSubject!, description: toHtml(review.draftBody!), email_config_id: emailConfigId, status: 6, priority: 2,
    tags: [REVIEW_TAG], custom_fields: { cf_order_id: review.orderNumber! },
  })
  await prisma.csReview.update({ where: { id: review.id }, data: { status: 'SENT', fdTicketId: sent.id, sentAt: now } })
  if (review.taskId) {
    await prisma.csTask.update({
      where: { id: review.taskId },
      data: { status: 'WAITING', events: { create: { kind: 'STATUS', body: `Đã gửi email review tới ${email} (Freshdesk #${sent.id})`, fromStatus: 'NEW', toStatus: 'WAITING', authorName: 'Agent', createdAt: now } } },
    })
  }
}

const toHtml = (text: string) => text.trim().split(/\n{2,}/).map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`).join('')

// Owner 11/08: every 1★ review gets one email asking what went wrong, unless the customer is already talking to us, the
// order was refunded, or we cannot tell who they are; those wait on the board for the owner.
export async function processReviews(deps: ProcessDeps): Promise<{ tasks: number; sent: number }> {
  const now = deps.now ?? new Date()
  const settings = await getCsSettings()
  const canSend = settings.reviewOutreachEnabled && !settings.killSwitch
  let tasks = 0
  let sent = 0
  for (const review of await prisma.csReview.findMany({ where: { status: 'NEW', rating: 1 }, orderBy: { reviewCreatedAt: 'desc' } })) {
    const m = await matchReview(review)
    if (!m.orderNumber) { await park(review, null, (m as { reason: string }).reason, now); tasks++; continue }
    const since = now.getTime() - TICKET_WINDOW_DAYS * 86400_000
    const recent = (await deps.fdLookup.ticketsByEmail(review.reviewerEmail!)).filter(t => Date.parse(t.created_at) >= since)
    if (recent.length) { await park(review, m.orderNumber, `khách đã có ticket ${recent.map(t => `#${t.id}`).join(', ')} trong ${TICKET_WINDOW_DAYS} ngày`, now); tasks++; continue }
    const order = await prisma.order.findFirst({ where: { shopifyOrderNumber: m.orderNumber }, select: { refundedAmount: true } })
    if ((order?.refundedAmount ?? 0) > 0) { await park(review, m.orderNumber, `đơn ${m.orderNumber} đã hoàn tiền $${order!.refundedAmount.toFixed(2)}`, now); tasks++; continue }
    if (!deps.llm) continue
    await prisma.csReview.update({ where: { id: review.id }, data: { orderNumber: m.orderNumber, matchNote: null } })
    const draft = await draftForReview(review.id, { llm: deps.llm, now })
    const task = await openTask({
      ticketId: null, orderNumber: m.orderNumber, type: 'REVIEW_RECOVERY', source: 'AGENT', actor: null, reviewId: review.id,
      detail: `${quote(review)}\nNhóm: ${draft.caseType}. Việc tiếp theo gợi ý (${TASK_META[draft.taskType]?.label ?? draft.taskType}): ${draft.taskDetail}`,
    }, now)
    tasks++
    await prisma.csTaskEvent.create({ data: { taskId: task.id, kind: 'COMMENT', body: `Bản nháp email:\n${draft.subject}\n\n${draft.body}`, authorName: 'Agent', createdAt: now } })
    if (draft.blocked) {
      await prisma.csTaskEvent.create({ data: { taskId: task.id, kind: 'COMMENT', body: `Bản nháp vi phạm quy tắc (${draft.blocked}), không gửi — CS viết tay.`, authorName: 'Agent', createdAt: now } })
      await prisma.csReview.update({ where: { id: review.id }, data: { status: 'BLOCKED', taskId: task.id } })
      continue
    }
    const fresh = await prisma.csReview.update({ where: { id: review.id }, data: { status: 'DRAFTED', taskId: task.id } })
    if (canSend) { await send(fresh, settings.outboundEmailConfigId, deps.fd, now); sent++ }
  }
  if (canSend) {
    for (const review of await prisma.csReview.findMany({ where: { status: 'DRAFTED' }, orderBy: { reviewCreatedAt: 'desc' } })) {
      if (!review.draftBody || !review.draftSubject || !review.reviewerEmail || !review.orderNumber) continue
      await send(review, settings.outboundEmailConfigId, deps.fd, now)
      sent++
    }
  }
  return { tasks, sent }
}

export async function followUpRatings(client: Pick<JudgemeClient, 'getReview'>, now = new Date()): Promise<{ changed: number }> {
  let changed = 0
  for (const review of await prisma.csReview.findMany({ where: { taskId: { not: null } } })) {
    const task = await prisma.csTask.findUnique({ where: { id: review.taskId! }, select: { id: true, status: true } })
    if (!task || !OPEN_TASK.includes(task.status)) continue
    const live = await client.getReview(review.judgemeId)
    if (!live || live.rating === review.rating) continue
    await prisma.csReview.update({ where: { id: review.id }, data: { rating: live.rating } })
    await prisma.csTaskEvent.create({ data: { taskId: task.id, kind: 'COMMENT', body: `Khách đã đổi đánh giá: ${live.rating}★`, authorName: 'Agent', createdAt: now } })
    changed++
  }
  return { changed }
}
