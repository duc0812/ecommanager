import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { pendingReviews, reviewDue, reviewTicket } from '@/lib/cs/review'
import { LlmCapReached } from '@/lib/llm/cap'
import { saveCsSettings } from '@/lib/cs/settings'

const T = (iso: string) => new Date(iso)

type Msg = { author: 'CUSTOMER' | 'STAFF' | 'AGENT'; at: string; source?: string; private?: boolean; text?: string }
async function mk(fdId: number, msgs: Msg[], patch: Record<string, unknown> = {}) {
  const first = msgs[0]
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `rev ${fdId}`, fdStatus: 2, fdPriority: 1, fdCreatedAt: T(first.at), fdUpdatedAt: T(first.at), lastCustomerAt: T(first.at), ...patch } })
  const ids: string[] = []
  let i = 0
  for (const m of msgs) {
    const row = await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `rev-${fdId}-${i++}`, author: m.author, private: !!m.private, bodyText: m.text ?? `${m.author} says hi`, createdAt: T(m.at), source: m.source ?? (m.author === 'AGENT' ? 'AGENT' : 'FRESHDESK') } })
    ids.push(row.id)
  }
  return { t, ids }
}

function fakeLlm(build: (user: string) => any) {
  const llm = {
    calls: 0,
    lastUser: '',
    async complete(i: any) { llm.calls += 1; llm.lastUser = i.user; return { output: build(i.user), tokensIn: 10, tokensOut: 5 } },
    async analyze(): Promise<any> { throw new Error('not used') },
  }
  return llm as Llm & { calls: number; lastUser: string }
}

beforeEach(async () => { await prisma.csTicket.deleteMany({}); await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } }); await saveCsSettings({ llmDailyCallCap: 500 }) })
afterAll(async () => { await prisma.csTicket.deleteMany({}); await saveCsSettings({ llmDailyCallCap: 500 }) })

describe('reviewDue', () => {
  const now = T('2026-10-24T12:00:00Z')
  it('closed, quiet 48h, or new reply since last review', () => {
    const base = { fdStatus: 2, reviewedAt: null, lastCustomerAt: T('2026-10-24T10:00:00Z'), lastReplyAt: T('2026-10-24T11:00:00Z') }
    expect(reviewDue({ ...base, fdStatus: 5 }, base.lastReplyAt, now)).toBe(true)
    expect(reviewDue(base, base.lastReplyAt, now)).toBe(false)
    expect(reviewDue({ ...base, lastCustomerAt: T('2026-10-21T10:00:00Z'), lastReplyAt: T('2026-10-21T11:00:00Z') }, T('2026-10-21T11:00:00Z'), now)).toBe(true)
    expect(reviewDue({ ...base, reviewedAt: T('2026-10-24T10:30:00Z') }, base.lastReplyAt, now)).toBe(true)
    expect(reviewDue({ ...base, fdStatus: 5, reviewedAt: T('2026-10-24T11:30:00Z') }, base.lastReplyAt, now)).toBe(false)
    expect(reviewDue({ ...base, fdStatus: 5 }, null, now)).toBe(false)
  })
})

describe('pendingReviews', () => {
  it('never picks a ticket that has no analysis (the backfill owns it) and still finds due tickets behind 200 reviewed ones', async () => {
    const now = T('2026-10-24T12:00:00Z')
    const untriaged = await mk(310, [{ author: 'CUSTOMER', at: '2026-10-01T08:00:00Z' }, { author: 'STAFF', at: '2026-10-01T09:00:00Z' }], { fdStatus: 5 })
    for (let i = 0; i < 201; i++) {
      const { t } = await mk(1000 + i, [{ author: 'CUSTOMER', at: '2026-10-02T08:00:00Z' }, { author: 'STAFF', at: '2026-10-02T09:00:00Z' }], { fdStatus: 5, reviewedAt: T('2026-10-03T00:00:00Z') })
      await prisma.csAnalysis.create({ data: { ticketId: t.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'OTHER', urgency: 'LOW', sentiment: 'CALM', summary: 's', proposal: 'p', needsHuman: false } })
    }
    const { t: due } = await mk(311, [{ author: 'CUSTOMER', at: '2026-10-20T08:00:00Z' }, { author: 'STAFF', at: '2026-10-20T09:00:00Z' }], { fdStatus: 5 })
    await prisma.csAnalysis.create({ data: { ticketId: due.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'OTHER', urgency: 'LOW', sentiment: 'CALM', summary: 's', proposal: 'p', needsHuman: false } })
    const { t: newer } = await mk(312, [{ author: 'CUSTOMER', at: '2026-10-21T08:00:00Z' }, { author: 'STAFF', at: '2026-10-21T09:00:00Z' }, { author: 'STAFF', at: '2026-10-23T09:00:00Z' }], { fdStatus: 5, reviewedAt: T('2026-10-22T00:00:00Z') })
    await prisma.csAnalysis.create({ data: { ticketId: newer.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'OTHER', urgency: 'LOW', sentiment: 'CALM', summary: 's', proposal: 'p', needsHuman: false } })
    const ids = await pendingReviews(5, now)
    expect(ids).toContain(due.id)
    expect(ids).toContain(newer.id)
    expect(ids).not.toContain(untriaged.t.id)
  })
})

describe('reviewTicket', () => {
  it('grades staff and agent replies, skips DRAFT_UNCHANGED, tags customer sentiments', async () => {
    const { t, ids } = await mk(301, [
      { author: 'CUSTOMER', at: '2026-10-20T08:00:00Z', text: 'My mug says Laurence not Laurance' },
      { author: 'STAFF', at: '2026-10-20T09:00:00Z', text: 'Please send a photo of the label so we can verify.' },
      { author: 'CUSTOMER', at: '2026-10-20T10:00:00Z', text: 'Here you go, this is ridiculous' },
      { author: 'STAFF', at: '2026-10-20T10:30:00Z', source: 'DRAFT_UNCHANGED', text: 'We are remaking it now.' },
      { author: 'AGENT', at: '2026-10-21T10:30:00Z', text: 'It shipped today.' },
      { author: 'STAFF', at: '2026-10-21T11:00:00Z', private: true, text: 'internal' },
    ], { fdStatus: 5 })
    const llm = fakeLlm(user => ({
      messageSentiments: [{ messageId: ids[0], sentiment: 'FRUSTRATED' }, { messageId: ids[2], sentiment: 'ANGRY' }],
      replies: [
        { messageId: ids[1], score: 2, issues: ['ASKED_PHOTO_AS_PROOF', 'TONE'], reason: 'Asks for proof: "Please send a photo"', rewrite: 'So sorry — where exactly is it wrong? We will remake it.' },
        { messageId: ids[3], score: 4, issues: ['GOOD'], reason: 'ok', rewrite: null },
        { messageId: ids[4], score: 3, issues: ['NO_RESOLUTION'], reason: 'no date', rewrite: null },
      ],
      ticketVerdict: 'RESOLVED', verdictNote: 'remade',
    }))
    const r = await reviewTicket(t.id, { llm, now: T('2026-10-24T12:00:00Z') })
    expect(r.reviews).toBe(3)
    expect(llm.lastUser).toContain(ids[1])
    expect(llm.lastUser).not.toContain('internal')
    const reviews = await prisma.csReplyReview.findMany({ where: { ticketId: t.id }, orderBy: { score: 'asc' } })
    expect(reviews.map(x => x.messageId).sort()).toEqual([ids[1], ids[3], ids[4]].sort())
    expect(JSON.parse(reviews[0].issues)).toContain('ASKED_PHOTO_AS_PROOF')
    const msgs = await prisma.csMessage.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: 'asc' } })
    expect(msgs[0].sentiment).toBe('FRUSTRATED')
    expect(msgs[2].sentiment).toBe('ANGRY')
    const ticket = await prisma.csTicket.findUnique({ where: { id: t.id } })
    expect(ticket!.reviewedAt).not.toBeNull()
    expect(ticket!.reviewSeq).toBe(1)
  })
  it('adds TOO_SLOW when the first response exceeded 24h', async () => {
    const { t, ids } = await mk(302, [
      { author: 'CUSTOMER', at: '2026-10-20T08:00:00Z' },
      { author: 'STAFF', at: '2026-10-21T20:00:00Z' },
    ], { fdStatus: 5 })
    const llm = fakeLlm(() => ({ messageSentiments: [{ messageId: ids[0], sentiment: 'CALM' }], replies: [{ messageId: ids[1], score: 4, issues: ['GOOD'], reason: 'fine', rewrite: null }], ticketVerdict: 'RESOLVED', verdictNote: '' }))
    await reviewTicket(t.id, { llm, now: T('2026-10-24T12:00:00Z') })
    const review = await prisma.csReplyReview.findUnique({ where: { messageId: ids[1] } })
    expect(JSON.parse(review!.issues)).toEqual(expect.arrayContaining(['GOOD', 'TOO_SLOW']))
  })
  it('stops at the daily cap without marking the ticket reviewed', async () => {
    await saveCsSettings({ llmDailyCallCap: 0 })
    const { t } = await mk(303, [{ author: 'CUSTOMER', at: '2026-10-20T08:00:00Z' }, { author: 'STAFF', at: '2026-10-20T09:00:00Z' }], { fdStatus: 5 })
    const llm = fakeLlm(() => ({ messageSentiments: [], replies: [], ticketVerdict: 'UNCLEAR', verdictNote: '' }))
    await expect(reviewTicket(t.id, { llm, now: T('2026-10-24T12:00:00Z') })).rejects.toBeInstanceOf(LlmCapReached)
    expect(llm.calls).toBe(0)
    expect((await prisma.csTicket.findUnique({ where: { id: t.id } }))!.reviewedAt).toBeNull()
  })
})
