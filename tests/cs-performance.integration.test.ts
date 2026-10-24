import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { computePerformance, weekBounds } from '@/lib/cs/performance'

const T = (iso: string) => new Date(iso)
const period = { from: T('2026-10-19T17:00:00Z'), to: T('2026-10-25T16:59:59Z') }

type Msg = { author: 'CUSTOMER' | 'STAFF' | 'AGENT'; at: string; sentiment?: string; source?: string; private?: boolean }
async function mk(fdId: number, msgs: Msg[], patch: Record<string, unknown> = {}) {
  const first = msgs.find(m => m.author === 'CUSTOMER')!
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `perf ${fdId}`, fdStatus: 2, fdPriority: 1, fdCreatedAt: T(first.at), fdUpdatedAt: T(first.at), lastCustomerAt: T(first.at), ...patch } })
  let i = 0
  for (const m of msgs) {
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `perf-${fdId}-${i++}`, author: m.author, private: !!m.private, bodyText: 'x', createdAt: T(m.at), sentiment: m.sentiment ?? null, source: m.source ?? (m.author === 'AGENT' ? 'AGENT' : 'FRESHDESK') } })
  }
  return t
}

beforeAll(async () => {
  await prisma.csTicket.deleteMany({})
  await mk(1, [
    { author: 'CUSTOMER', at: '2026-10-20T08:00:00Z', sentiment: 'FRUSTRATED' },
    { author: 'STAFF', at: '2026-10-20T10:00:00Z' },
    { author: 'CUSTOMER', at: '2026-10-20T12:00:00Z', sentiment: 'CALM' },
    { author: 'STAFF', at: '2026-10-21T18:00:00Z' },
  ], { fdFirstRespondedAt: T('2026-10-20T10:00:00Z') })
  await mk(2, [
    { author: 'CUSTOMER', at: '2026-10-21T08:00:00Z', sentiment: 'CALM' },
    { author: 'STAFF', at: '2026-10-22T20:00:00Z' },
    { author: 'CUSTOMER', at: '2026-10-23T08:00:00Z', sentiment: 'ANGRY' },
    { author: 'STAFF', at: '2026-10-23T09:00:00Z' },
    { author: 'STAFF', at: '2026-10-23T10:00:00Z' },
    { author: 'STAFF', at: '2026-10-23T11:00:00Z' },
  ])
  await mk(3, [
    { author: 'CUSTOMER', at: '2026-10-22T08:00:00Z', sentiment: 'CALM' },
    { author: 'STAFF', at: '2026-10-22T09:00:00Z', source: 'DRAFT_UNCHANGED' },
    { author: 'CUSTOMER', at: '2026-10-22T10:00:00Z', sentiment: 'CALM' },
  ])
  await mk(4, [
    { author: 'CUSTOMER', at: '2026-10-22T12:00:00Z', sentiment: 'CALM' },
    { author: 'AGENT', at: '2026-10-22T12:05:00Z' },
    { author: 'CUSTOMER', at: '2026-10-22T13:00:00Z', sentiment: 'CALM' },
  ])
  await mk(5, [
    { author: 'CUSTOMER', at: '2026-10-23T08:00:00Z', sentiment: 'CALM' },
    { author: 'STAFF', at: '2026-10-23T09:00:00Z' },
    { author: 'CUSTOMER', at: '2026-10-24T08:00:00Z', sentiment: 'ANGRY' },
  ], { fdStatus: 2, fdResolvedAt: T('2026-10-23T09:30:00Z'), reopenCount: 1 })
  await mk(6, [{ author: 'CUSTOMER', at: '2026-10-10T08:00:00Z', sentiment: 'CALM' }, { author: 'STAFF', at: '2026-10-10T09:00:00Z' }])
})
afterAll(async () => { await prisma.csTicket.deleteMany({}) })

describe('computePerformance', () => {
  it('measures first and next response times for staff', async () => {
    const m = await computePerformance(period)
    expect(m.tickets).toBe(5)
    expect(m.staff.firstResponse.count).toBe(3)
    expect(m.staff.firstResponse.medianH).toBe(2)
    expect(m.staff.firstResponse.p90H).toBe(36)
    expect(m.staff.firstResponse.over24hPct).toBeCloseTo(33.3, 0)
    expect(m.staff.firstResponse.worst[0].fdTicketId).toBe(2)
    expect(m.staff.nextResponse.count).toBe(2)
    expect(m.staff.nextResponse.medianH).toBe(15.5)
  })
  it('counts replies per ticket excluding unchanged drafts', async () => {
    const m = await computePerformance(period)
    expect(m.staff.repliesPerTicket.over3).toEqual([{ ticketId: expect.any(String), fdTicketId: 2, replies: 4 }])
    expect(m.staff.repliesPerTicket.mean).toBeCloseTo(2.33, 1)
    expect(m.staff.draftUnchanged).toBe(1)
  })
  it('counts premature closes with the reopening sentiment', async () => {
    const m = await computePerformance(period)
    expect(m.staff.prematureCloses.count).toBe(1)
    expect(m.staff.prematureCloses.items[0]).toEqual({ ticketId: expect.any(String), fdTicketId: 5, reopenSentiment: 'ANGRY' })
  })
  it('tracks sentiment after each reply for staff and agent', async () => {
    const m = await computePerformance(period)
    expect(m.staff.sentimentAfterReply).toMatchObject({ improved: 1, same: 0, worse: 2 })
    expect(m.staff.sentimentAfterReply.worseItems.map(w => w.fdTicketId).sort()).toEqual([2, 5])
    expect(m.agent.sentimentAfterReply).toMatchObject({ improved: 0, same: 2, worse: 0 })
    expect(m.agent.firstResponse.count).toBe(2)
  })
  it('weekBounds returns Monday 00:00 VN to Sunday 23:59:59 VN', () => {
    const w = weekBounds(new Date('2026-10-24T03:00:00Z'))
    expect(w.from.toISOString()).toBe('2026-10-18T17:00:00.000Z')
    expect(w.to.toISOString()).toBe('2026-10-25T16:59:59.999Z')
    expect(weekBounds(new Date('2026-10-24T03:00:00Z'), -1).from.toISOString()).toBe('2026-10-11T17:00:00.000Z')
  })
})
