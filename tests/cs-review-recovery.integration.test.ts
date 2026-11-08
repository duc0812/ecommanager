import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { JmReview } from '@/lib/cs/judgeme'
import { matchReview, syncReviews } from '@/lib/cs/review-recovery'

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
