import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { JmReview } from '@/lib/cs/judgeme'
import { followUpRatings, matchReview, processReviews, syncReviews } from '@/lib/cs/review-recovery'
import { saveCsSettings } from '@/lib/cs/settings'

const PROJECT = 'proj_rr'
const SHOP = 'rr-test.myshopify.com'
let storeId = ''
let seq = 0

type LineIn = { sku: string; title: string; productId?: string | null; position?: number }
async function makeOrder(email: string, placedAt: string, lines: LineIn[], extra: Record<string, unknown> = {}) {
  seq++
  const id = `gid://test/Order/rr-${seq}`
  const number = `#RR${1000 + seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD', grossAmount: 50, expectedPayout: 48, totalFees: 2, refundedAmount: 0,
      placedAt: new Date(placedAt), pipelineStatus: 'FULFILLED', orderType: 'CUSTOM', designReady: true, customerEmail: email, customerName: 'Ann Lee', shippingCountry: 'US', ...extra,
      lines: { create: lines.map((l, i) => ({ shopifyLineId: `rrl-${seq}-${i}`, productTitle: l.title, variantTitle: 'One', qty: 1, linePosition: l.position ?? i + 1, unitPrice: 40, sku: l.sku, customized: false, shopifyProductId: l.productId === undefined ? null : l.productId })) },
    },
  })
  return { id, number }
}

const jm = (p: Partial<JmReview> & { id: number }): JmReview => ({
  title: null, body: 'Bad', rating: 1, productExternalId: '8891490140317', productTitle: 'Stwa Galaxy Shirt', productHandle: 'stwa', reviewerEmail: 'ann@example.com', reviewerName: 'Ann L.',
  verified: 'buyer', hidden: false, createdAt: new Date('2026-11-05T00:00:00Z'), ...p,
})

function fakeClient(pages: JmReview[][]) {
  const calls: number[] = []
  return { calls, async listReviews(o: { rating: number; page: number; perPage: number }) { calls.push(o.page); return pages[o.page - 1] ?? [] } }
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'RR', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
})
beforeEach(async () => {
  await prisma.csReview.deleteMany({})
  await prisma.csTask.deleteMany({})
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
})
afterAll(async () => {
  await prisma.csReview.deleteMany({})
  await prisma.csTask.deleteMany({})
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
})

describe('syncReviews', () => {
  it('stores new 1★ reviews once', async () => {
    const client = fakeClient([[jm({ id: 1 }), jm({ id: 2 })]])
    expect((await syncReviews(client)).added).toBe(2)
    expect((await syncReviews(client)).added).toBe(0)
    expect(await prisma.csReview.count()).toBe(2)
    const r = await prisma.csReview.findUniqueOrThrow({ where: { judgemeId: 1 } })
    expect(r).toMatchObject({ rating: 1, reviewerEmail: 'ann@example.com', productExternalId: '8891490140317', status: 'NEW' })
  })
  it('keeps the status of a review already handled', async () => {
    const client = fakeClient([[jm({ id: 3 })]])
    await syncReviews(client)
    await prisma.csReview.update({ where: { judgemeId: 3 }, data: { status: 'SENT' } })
    await syncReviews(fakeClient([[jm({ id: 3, body: 'Edited' })]]))
    expect((await prisma.csReview.findUniqueOrThrow({ where: { judgemeId: 3 } })).status).toBe('SENT')
  })
  it('stops paging once a page holds only reviews it already has', async () => {
    await syncReviews(fakeClient([[jm({ id: 4 })]]))
    const client = fakeClient([[jm({ id: 5 })], [jm({ id: 4 })], [jm({ id: 99 })]])
    await syncReviews(client)
    expect(client.calls).toEqual([1, 2])
  })
})

describe('matchReview', () => {
  const review = { reviewerEmail: 'ann@example.com', productExternalId: '8891490140317', productTitle: 'Stwa Galaxy Shirt', reviewCreatedAt: new Date('2026-11-05T00:00:00Z') }
  it('finds the order by email and product id', async () => {
    const o = await makeOrder('Ann@Example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }])
    expect(await matchReview(review)).toMatchObject({ orderNumber: o.number })
  })
  it('falls back to the SKU parent code in the product title', async () => {
    const o = await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'DN2509261948-US, 20OZ', title: 'HaPo Wizard Tumbler DN2509261948' }])
    expect(await matchReview({ ...review, productExternalId: '1', productTitle: 'HaPo Wizard 25 Years Of Magic Tumbler DN2509261948' })).toMatchObject({ orderNumber: o.number })
  })
  it('takes the latest order before the review date', async () => {
    await makeOrder('ann@example.com', '2026-09-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa', productId: 'gid://shopify/Product/8891490140317' }])
    const latest = await makeOrder('ann@example.com', '2026-10-20T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa', productId: 'gid://shopify/Product/8891490140317' }])
    await makeOrder('ann@example.com', '2026-11-06T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa', productId: 'gid://shopify/Product/8891490140317' }])
    expect(await matchReview(review)).toMatchObject({ orderNumber: latest.number })
  })
  it('returns null when no order has the product', async () => {
    await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'OTHER-1', title: 'Mug', productId: 'gid://shopify/Product/555' }])
    const m = await matchReview(review)
    expect(m.orderNumber).toBeNull()
    expect('reason' in m && m.reason).toMatch(/không/i)
  })
  it('returns null without a reviewer email', async () => {
    expect((await matchReview({ ...review, reviewerEmail: null })).orderNumber).toBeNull()
  })
  it('a review on Shipping protection matches the reviewer latest order before the review', async () => {
    const o = await makeOrder('ann@example.com', '2026-10-10T00:00:00Z', [{ sku: '', title: 'Shipping protection', productId: 'gid://shopify/Product/777', position: 2 }, { sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317', position: 1 }])
    const m = await matchReview({ ...review, productExternalId: '777', productTitle: 'Shipping protection' })
    expect(m).toMatchObject({ orderNumber: o.number })
  })
})

describe('draftForReview', () => {
  it('stores the draft and returns the guard result', async () => {
    const { draftForReview } = await import('@/lib/cs/review-recovery')
    await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }])
    await syncReviews(fakeClient([[jm({ id: 11 })]]))
    const row = await prisma.csReview.findUniqueOrThrow({ where: { judgemeId: 11 } })
    const m = await matchReview(row)
    await prisma.csReview.update({ where: { id: row.id }, data: { orderNumber: m.orderNumber } })
    let seenUser = ''
    const llm = {
      async analyze(): Promise<any> { throw new Error('not used') },
      async complete({ user }: { user: string }): Promise<any> {
        seenUser = user
        return { output: { caseType: 'NOT_RECEIVED', taskType: 'CARRIER_CHECK', taskDetail: 'Kiểm tra vận chuyển', subject: 'Your Stwa shirt', body: 'Hi Ann,\n\nWe saw the review you left for the Stwa Galaxy Shirt on order #RR1. Could you tell us what happened?\n\nWarm regards,\nLitzzy Support', alsoCsComplaint: false }, tokensIn: 1, tokensOut: 1 }
      },
    }
    const d = await draftForReview(row.id, { llm: llm as any })
    expect(d).toMatchObject({ caseType: 'NOT_RECEIVED', taskType: 'CARRIER_CHECK', blocked: null })
    expect(seenUser).toContain('Stwa Galaxy Shirt')
    const after = await prisma.csReview.findUniqueOrThrow({ where: { id: row.id } })
    expect(after).toMatchObject({ caseType: 'NOT_RECEIVED', draftSubject: 'Your Stwa shirt' })
    expect(after.draftBody).toContain('We saw the review')
  })
})

describe('processReviews', () => {
  const CLEAN = 'Hi Ann,\n\nWe saw the review you left for the Stwa Galaxy Shirt on order #RR1. Could you tell us what happened?\n\nWarm regards,\nLitzzy Support'
  function llmReturning(body = CLEAN) {
    const llm = {
      calls: 0,
      async analyze(): Promise<any> { throw new Error('not used') },
      async complete(): Promise<any> {
        llm.calls++
        return { output: { caseType: 'NOT_RECEIVED', taskType: 'CARRIER_CHECK', taskDetail: 'Kiểm tra vận chuyển đơn', subject: 'About your Stwa shirt', body, alsoCsComplaint: false }, tokensIn: 1, tokensOut: 1 }
      },
    }
    return llm
  }
  function fd(ticketsByEmail: Record<string, { id: number; created_at: string }[]> = {}) {
    const sent: any[] = []
    return {
      sent,
      fd: { async outboundEmail(p: any) { sent.push(p); return { id: 900 + sent.length } } },
      fdLookup: { async ticketsByEmail(email: string) { return ticketsByEmail[email] ?? [] } },
    }
  }
  const NOW = new Date('2026-11-08T12:00:00Z')
  async function seed(id = 21) {
    const o = await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }])
    await syncReviews(fakeClient([[jm({ id })]]))
    return o
  }
  beforeEach(async () => { await saveCsSettings({ reviewOutreachEnabled: false, killSwitch: false }) })

  it('a matched review gets a task and an email when the switch is on', async () => {
    const o = await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    const r = await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(r).toMatchObject({ tasks: 1, sent: 1 })
    expect(f.sent[0]).toMatchObject({ email: 'ann@example.com', tags: ['em-review-1star'], custom_fields: { cf_order_id: o.number }, status: 6 })
    const review = await prisma.csReview.findFirstOrThrow()
    expect(review).toMatchObject({ status: 'SENT', fdTicketId: 901, orderNumber: o.number })
    const task = await prisma.csTask.findFirstOrThrow({ include: { events: true } })
    expect(task).toMatchObject({ type: 'REVIEW_RECOVERY', status: 'WAITING', reviewId: review.id, orderNumber: o.number })
    expect(task.events.some(e => e.body.includes('#901'))).toBe(true)
  })
  it('with the switch off it drafts and opens the task but sends nothing', async () => {
    await seed()
    const f = fd()
    const r = await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(r).toMatchObject({ tasks: 1, sent: 0 })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('DRAFTED')
    expect((await prisma.csTask.findFirstOrThrow()).status).toBe('NEW')
  })
  it('turning the switch on sends the stored drafts once', async () => {
    await seed()
    const f = fd()
    const llm = llmReturning()
    await processReviews({ llm: llm as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await saveCsSettings({ reviewOutreachEnabled: true })
    await processReviews({ llm: llm as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await processReviews({ llm: llm as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(1)
    expect(llm.calls).toBe(1)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('SENT')
  })
  it('a reviewer with a ticket in the last 90 days is parked without an email or llm call', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd({ 'ann@example.com': [{ id: 249, created_at: '2026-10-26T00:00:00Z' }] })
    const llm = llmReturning()
    await processReviews({ llm: llm as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
    expect(llm.calls).toBe(0)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
    expect((await prisma.csTask.findFirstOrThrow()).detail).toContain('#249')
  })
  it('a ticket older than 90 days does not park the review', async () => {
    await seed()
    const f = fd({ 'ann@example.com': [{ id: 10, created_at: '2026-06-01T00:00:00Z' }] })
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('DRAFTED')
  })
  it('a refunded order is parked', async () => {
    const o = await seed()
    await prisma.order.update({ where: { id: o.id }, data: { refundedAmount: 12 } })
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
    expect((await prisma.csTask.findFirstOrThrow()).detail).toMatch(/hoàn tiền/i)
  })
  it('an unmatched review is parked with the reason', async () => {
    await syncReviews(fakeClient([[jm({ id: 31, reviewerEmail: 'nobody@example.com' })]]))
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
    expect((await prisma.csTask.findFirstOrThrow()).detail).toContain('nobody@example.com')
  })
  it('a blocked draft is not sent and the task says CS must write it', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    await processReviews({ llm: llmReturning(CLEAN + '\nWould you consider updating your review?') as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('BLOCKED')
    const task = await prisma.csTask.findFirstOrThrow({ include: { events: true } })
    expect(task.events.some(e => e.body.includes('CS viết tay'))).toBe(true)
  })
  it('second run sends nothing and opens no task', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await syncReviews(fakeClient([[jm({ id: 21 })]]))
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(1)
    expect(await prisma.csTask.count()).toBe(1)
  })
  it('the kill switch stops sending', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true, killSwitch: true })
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
  })
  it('a raised rating is logged on the open task', async () => {
    await seed()
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    const client = { async getReview(id: number) { return jm({ id, rating: 4 }) } }
    expect((await followUpRatings(client, NOW)).changed).toBe(1)
    expect((await prisma.csReview.findFirstOrThrow()).rating).toBe(4)
    const task = await prisma.csTask.findFirstOrThrow({ include: { events: true } })
    expect(task.events.some(e => e.body.includes('Khách đã đổi đánh giá: 4★'))).toBe(true)
    expect(task.status).toBe('NEW')
    expect((await followUpRatings(client, NOW)).changed).toBe(0)
  })
})

describe('final review fixes', () => {
  const CLEAN = 'Hi Ann,\n\nWe saw the review you left for the Stwa Galaxy Shirt on order #RR1. Could you tell us what happened?\n\nWarm regards,\nLitzzy Support'
  function llmReturning(body = CLEAN, subject = 'About your Stwa shirt') {
    const llm = {
      calls: 0,
      async analyze(): Promise<any> { throw new Error('not used') },
      async complete(): Promise<any> {
        llm.calls++
        return { output: { caseType: 'NOT_RECEIVED', taskType: 'CARRIER_CHECK', taskDetail: 'Kiểm tra', subject, body, alsoCsComplaint: false }, tokensIn: 1, tokensOut: 1 }
      },
    }
    return llm
  }
  function fd(ticketsByEmail: Record<string, { id: number; created_at: string }[]> = {}) {
    const sent: any[] = []
    return {
      sent,
      fd: { async outboundEmail(p: any) { sent.push(p); return { id: 900 + sent.length } } },
      fdLookup: { async ticketsByEmail(email: string) { return ticketsByEmail[email] ?? [] } },
    }
  }
  const NOW = new Date('2026-11-08T12:00:00Z')
  async function seed(id = 41, review: Partial<JmReview> = {}, customerName = 'Ann Lee') {
    const o = await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }], { customerName })
    await syncReviews(fakeClient([[jm({ id, ...review })]]))
    return o
  }
  beforeEach(async () => {
    await saveCsSettings({ reviewOutreachEnabled: false, killSwitch: false })
    await prisma.csTicket.deleteMany({ where: { fdTicketId: 88001 } })
  })

  it('a ticket the tool already holds for the reviewer parks the review', async () => {
    await seed()
    await prisma.csTicket.create({ data: { fdTicketId: 88001, subject: 'x', fdStatus: 4, fdPriority: 1, requesterEmail: 'Ann@Example.com', fdCreatedAt: new Date('2026-09-20T00:00:00Z'), fdUpdatedAt: new Date('2026-09-20T00:00:00Z') } })
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
    expect((await prisma.csTask.findFirstOrThrow()).detail).toContain('#88001')
  })
  it('a stored draft is not sent once its task was closed', async () => {
    await seed()
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await prisma.csTask.updateMany({ data: { status: 'DONE' } })
    await saveCsSettings({ reviewOutreachEnabled: true })
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
  })
  it('a stored draft is not sent once the customer raised the rating', async () => {
    await seed()
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await prisma.csReview.updateMany({ data: { rating: 4 } })
    await saveCsSettings({ reviewOutreachEnabled: true })
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
  })
  it('a stored draft is parked when the customer opened a ticket meanwhile', async () => {
    await seed()
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    await saveCsSettings({ reviewOutreachEnabled: true })
    const later = fd({ 'ann@example.com': [{ id: 555, created_at: '2026-11-07T00:00:00Z' }] })
    await processReviews({ llm: llmReturning() as any, fd: later.fd, fdLookup: later.fdLookup, now: NOW })
    expect(later.sent).toHaveLength(0)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
  })
  it('a subject that names the review score is blocked', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    await processReviews({ llm: llmReturning(CLEAN, 'About your 1-star review') as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('BLOCKED')
  })
  it('an empty subject is blocked', async () => {
    await seed()
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    await processReviews({ llm: llmReturning(CLEAN, '  ') as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('BLOCKED')
  })
  it('one failing review does not stop the others, and gives up after three tries', async () => {
    await makeOrder('ann@example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }])
    await makeOrder('bob@example.com', '2026-10-01T00:00:00Z', [{ sku: 'ST1-L', title: 'Stwa Galaxy Shirt', productId: 'gid://shopify/Product/8891490140317' }], { customerName: 'Bob Ray' })
    await syncReviews(fakeClient([[jm({ id: 51, createdAt: new Date('2026-11-06T00:00:00Z') }), jm({ id: 52, reviewerEmail: 'bob@example.com', reviewerName: 'Bob R.', createdAt: new Date('2026-11-05T00:00:00Z') })]]))
    const flaky = {
      async analyze(): Promise<any> { throw new Error('not used') },
      async complete({ user }: { user: string }): Promise<any> {
        if (user.includes('Ann L.')) throw new Error('model output failed the schema')
        return { output: { caseType: 'NOT_RECEIVED', taskType: 'CARRIER_CHECK', taskDetail: 'x', subject: 'About your shirt', body: CLEAN.replace('Ann', 'Bob'), alsoCsComplaint: false }, tokensIn: 1, tokensOut: 1 }
      },
    }
    const f = fd()
    for (let i = 0; i < 3; i++) await processReviews({ llm: flaky as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findUniqueOrThrow({ where: { judgemeId: 52 } })).status).toBe('DRAFTED')
    const bad = await prisma.csReview.findUniqueOrThrow({ where: { judgemeId: 51 } })
    expect(bad.status).toBe('ERROR')
    expect(bad.matchNote).toContain('schema')
  })
  it('a reviewer name that does not fit the order name is parked', async () => {
    await seed(61, { reviewerName: 'Gladys' }, 'Ann Lee')
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('PARKED')
    expect((await prisma.csTask.findFirstOrThrow()).detail).toMatch(/tên/i)
  })
  it('an anonymous reviewer name does not block the match', async () => {
    await seed(62, { reviewerName: 'Anonymous' }, 'Ann Lee')
    const f = fd()
    await processReviews({ llm: llmReturning() as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect((await prisma.csReview.findFirstOrThrow()).status).toBe('DRAFTED')
  })
  it('a hidden review is left alone', async () => {
    await seed(71, { hidden: true })
    await saveCsSettings({ reviewOutreachEnabled: true })
    const f = fd()
    const llm = llmReturning()
    await processReviews({ llm: llm as any, fd: f.fd, fdLookup: f.fdLookup, now: NOW })
    expect(f.sent).toHaveLength(0)
    expect(llm.calls).toBe(0)
    expect(await prisma.csTask.count()).toBe(0)
  })
})
