import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { runReviewBackfill } from '@/lib/cs/backfill'
import { saveCsSettings } from '@/lib/cs/settings'

const T = (iso: string) => new Date(iso)
const PROJECT = 'cs-bf-project'
const SHOP = 'cs-bf.myshopify.com'
const ORDER = 'cs-bf-order'

async function mk(fdId: number, at: string, patch: Record<string, unknown> = {}) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `bf ${fdId} #LIT8201`, fdStatus: 5, fdPriority: 1, fdCreatedAt: T(at), fdUpdatedAt: T(at), lastCustomerAt: T(at), orderId: ORDER, orderNumber: '#LIT8201', orderMatch: 'EXACT', ...patch } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `bf-${fdId}-0`, author: 'CUSTOMER', bodyText: 'The print is wrong', createdAt: T(at) } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `bf-${fdId}-1`, author: 'STAFF', bodyText: 'Send a photo please', createdAt: T(at.replace('08:00', '09:00')) } })
  return t
}

function fakeLlm() {
  const llm = {
    calls: [] as string[],
    async complete(i: any) {
      llm.calls.push(i.schemaName)
      const ids = [...i.user.matchAll(/\[(STAFF|CUSTOMER) ([a-z0-9]+)/g)].map(m => ({ role: m[1], id: m[2] }))
      const staff = ids.filter(x => x.role === 'STAFF').map(x => x.id)
      const customers = ids.filter(x => x.role === 'CUSTOMER').map(x => x.id)
      const review = { messageSentiments: customers.map(id => ({ messageId: id, sentiment: 'FRUSTRATED' })), replies: staff.map(id => ({ messageId: id, score: 2, issues: ['ASKED_PHOTO_AS_PROOF'], reason: 'r', rewrite: null })), ticketVerdict: 'UNCLEAR', verdictNote: '' }
      if (i.schemaName === 'cs_combined') return { output: { category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'FRUSTRATED', summary: 'sai in', proposal: 'in lại', rootCause: { stage: 'FACTORY', issueType: 'PRINT_QUALITY', confidence: 'MEDIUM', evidence: 'e', affectedLineIds: [] }, review }, tokensIn: 1, tokensOut: 1 }
      if (i.schemaName === 'cs_review') return { output: review, tokensIn: 1, tokensOut: 1 }
      throw new Error(`unexpected schema ${i.schemaName}`)
    },
    async analyze(): Promise<any> { throw new Error('not used') },
  }
  return llm as Llm & { calls: string[] }
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS bf', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.order.upsert({ where: { id: ORDER }, update: {}, create: { id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#LIT8201', financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: T('2026-10-01T00:00:00Z'), exportedAt: T('2026-10-02T00:00:00Z') } })
})
beforeEach(async () => {
  await prisma.csTicket.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: ['last_cs_review_backfill'] } } })
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } })
  await saveCsSettings({ llmDailyCallCap: 500 })
})
afterAll(async () => { await prisma.csTicket.deleteMany({}); await prisma.order.deleteMany({ where: { id: ORDER } }) })

describe('runReviewBackfill', () => {
  it('processes oldest first and resumes from progress', async () => {
    await mk(401, '2026-10-20T08:00:00Z'); await mk(402, '2026-10-21T08:00:00Z'); await mk(403, '2026-10-22T08:00:00Z')
    const llm = fakeLlm()
    const r1 = await runReviewBackfill({ llm, now: T('2026-10-24T12:00:00Z'), maxCalls: 2 })
    expect(r1.processed).toBe(2); expect(r1.remaining).toBe(1); expect(r1.capReached).toBe(false)
    const done = await prisma.csTicket.findMany({ where: { reviewedAt: { not: null } }, orderBy: { fdTicketId: 'asc' } })
    expect(done.map(t => t.fdTicketId)).toEqual([401, 402])
    expect(done[0].category).toBe('WRONG_ITEM')
    const a = await prisma.csAnalysis.findFirst({ where: { ticketId: done[0].id } })
    expect(a!.rootCauseStage).toBe('FACTORY')
    expect(await prisma.csReplyReview.count()).toBe(2)
    expect(llm.calls).toEqual(['cs_combined', 'cs_combined'])
    const r2 = await runReviewBackfill({ llm, now: T('2026-10-24T12:00:00Z'), maxCalls: 2 })
    expect(r2.processed).toBe(1); expect(r2.remaining).toBe(0)
    const progress = await prisma.appSetting.findUnique({ where: { key: 'last_cs_review_backfill' } })
    expect(JSON.parse(progress!.value).remaining).toBe(0)
  })
  it('uses the plain review pass for tickets that already have an analysis', async () => {
    const t = await mk(404, '2026-10-20T08:00:00Z', { category: 'WRONG_ITEM' })
    await prisma.csAnalysis.create({ data: { ticketId: t.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'CALM', summary: 's', proposal: 'p', needsHuman: true, rootCauseAt: T('2026-10-21T00:00:00Z'), rootCauseStage: 'DESIGN' } })
    const llm = fakeLlm()
    await runReviewBackfill({ llm, now: T('2026-10-24T12:00:00Z'), maxCalls: 5 })
    expect(llm.calls).toEqual(['cs_review'])
    expect((await prisma.csAnalysis.findFirst({ where: { ticketId: t.id } }))!.rootCauseStage).toBe('DESIGN')
  })
  it('stops at the daily cap and reports it', async () => {
    await saveCsSettings({ llmDailyCallCap: 1 })
    await mk(405, '2026-10-20T08:00:00Z'); await mk(406, '2026-10-21T08:00:00Z')
    const r = await runReviewBackfill({ llm: fakeLlm(), now: T('2026-10-24T12:00:00Z'), maxCalls: 5 })
    expect(r.processed).toBe(1); expect(r.capReached).toBe(true); expect(r.remaining).toBe(1)
  })
})
