import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import type { FdConversation, FdTicket } from '@/lib/cs/freshdesk'
import { FreshdeskBudgetExceeded, FreshdeskError } from '@/lib/cs/freshdesk'
import { authorOf, syncTickets, type FdLike } from '@/lib/cs/sync'
import { DEFAULT_CS_SETTINGS } from '@/lib/cs/settings'
import ticketsPage from './fixtures/cs/tickets-page.json'
import conversations119 from './fixtures/cs/conversations-119.json'

const tickets = ticketsPage as unknown as FdTicket[]
const conv119 = conversations119 as unknown as FdConversation[]

function fakeFd(opts: { failOn?: number } = {}): FdLike & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    requests: 0,
    async listTickets(_since: string, page = 1) {
      calls.push(`list:${page}`)
      return page === 1 ? tickets : []
    },
    async getConversations(id: number) {
      calls.push(`conv:${id}`)
      if (opts.failOn === id) throw new FreshdeskError(503, 'down')
      return id === 119 ? conv119 : []
    },
  }
}

async function clean() {
  await prisma.csTicket.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: 'cs.settings' } })
}
beforeEach(clean)
afterAll(clean)

describe('authorOf', () => {
  const s = { supportAgentId: 158024049112, ignoredAgentIds: [158024416092, 158024416093] }
  it('maps incoming to CUSTOMER, support agent to STAFF, Freddy to SKIP, ours to AGENT', () => {
    expect(authorOf(conv119[4], s, new Set())).toBe('CUSTOMER')
    expect(authorOf(conv119[3], s, new Set())).toBe('STAFF')
    expect(authorOf(conv119[0], s, new Set())).toBe('SKIP')
    expect(authorOf({ ...conv119[0], private: false }, s, new Set())).toBe('SYSTEM')
    expect(authorOf(conv119[3], s, new Set(['158049449778']))).toBe('AGENT')
  })
})

describe('syncTickets', () => {
  it('upserts tickets, description as first CUSTOMER message, and maps authors', async () => {
    const res = await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    expect(res.seen).toBe(3)
    expect(res.error).toBeUndefined()
    const t = await prisma.csTicket.findUnique({ where: { fdTicketId: 119 }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
    expect(t).not.toBeNull()
    expect(t!.requesterEmail).toBe('paul.test@example.com')
    expect(t!.orderNumber).toBe('#LIT4525')
    expect(t!.messages.map(m => [m.author, m.private])).toEqual([
      ['CUSTOMER', false],
      ['STAFF', true],
      ['STAFF', false],
      ['CUSTOMER', false],
    ])
    expect(t!.lastCustomerAt?.toISOString()).toBe('2026-10-23T14:16:19.000Z')
    expect(t!.lastReplyAt?.toISOString()).toBe('2026-10-23T09:26:05.000Z')
    expect(t!.messages[0].bodyText.length).toBeGreaterThan(0)
    const t195 = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 }, include: { messages: true } })
    expect(t195!.subject).toBe('LIT3910')
    expect(t195!.messages).toHaveLength(1)
    expect(res.changed).toHaveLength(3)
    expect(res.cursor).toBe('2026-10-23T14:39:58Z')
  })

  it('returns changed ids only for tickets with new customer text', async () => {
    await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    const again = await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    expect(again.changed).toEqual([])
  })

  it('advances the cursor only to the last fully processed ticket when a fetch fails mid-cycle', async () => {
    const res = await syncTickets(fakeFd({ failOn: 194 }), { since: '2026-10-19T00:00:00Z' })
    expect(res.error).toContain('503')
    expect(res.cursor).toBe('2026-10-23T14:16:18Z')
    expect(await prisma.csTicket.findUnique({ where: { fdTicketId: 119 } })).not.toBeNull()
    expect(await prisma.csTicket.findUnique({ where: { fdTicketId: 194 } })).toBeNull()
    const settings = await prisma.appSetting.findUnique({ where: { key: 'cs.settings' } })
    expect(JSON.parse(settings!.value).syncUpdatedSince).toBe('2026-10-23T14:16:18Z')
    const again = await syncTickets(fakeFd(), { since: res.cursor! })
    expect(again.changed).toHaveLength(2)
    expect(await prisma.csTicket.findUnique({ where: { fdTicketId: 194 } })).not.toBeNull()
  })

  it('reports a budget stop as partial, not as an error, and keeps the cursor before the unfetched tickets', async () => {
    const fd = fakeFd()
    let calls = 0
    const budgeted: FdLike = {
      requests: 0,
      listTickets: fd.listTickets,
      async getConversations(id: number) {
        if (++calls > 1) throw new FreshdeskBudgetExceeded(2)
        return fd.getConversations(id)
      },
    }
    const res = await syncTickets(budgeted, { since: '2026-10-19T00:00:00Z' })
    expect(res.error).toBeUndefined()
    expect(res.partial).toBe(true)
    expect(res.changed).toHaveLength(1)
    expect(res.cursor).toBe('2026-10-23T14:16:18Z')
  })

  it('takes the order number from the subject when the custom field is empty', async () => {
    await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    expect((await prisma.csTicket.findUnique({ where: { fdTicketId: 194 } }))!.orderNumber).toBe('#LIT5037')
    expect((await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } }))!.orderNumber).toBe('#LIT3910')
  })

  it('tags conversation ids we posted as AGENT', async () => {
    const ticket = await prisma.csTicket.create({
      data: { fdTicketId: 119, subject: 'x', fdStatus: 2, fdPriority: 1, fdCreatedAt: new Date('2026-10-20T05:48:29Z'), fdUpdatedAt: new Date('2026-10-20T05:48:29Z') },
    })
    await prisma.csMessage.create({ data: { ticketId: ticket.id, fdConversationId: '158049449778', author: 'AGENT', bodyText: 'sent by us', createdAt: new Date('2026-10-23T09:26:05Z') } })
    await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    const m = await prisma.csMessage.findUnique({ where: { fdConversationId: '158049449778' } })
    expect(m!.author).toBe('AGENT')
  })

  it('counts a public reply from another agent as a reply', async () => {
    const fd = fakeFd()
    const orig = fd.getConversations
    fd.getConversations = async (id: number) => (id === 119 ? [...conv119, { ...conv119[0], id: 777, private: false, created_at: '2026-10-23T15:00:00Z' }] : orig(id))
    await syncTickets(fd, { since: '2026-10-19T00:00:00Z' })
    const t = await prisma.csTicket.findUnique({ where: { fdTicketId: 119 }, include: { messages: true } })
    expect(t!.messages.find(m => m.fdConversationId === '777')!.author).toBe('SYSTEM')
    expect(t!.lastReplyAt?.toISOString()).toBe('2026-10-23T15:00:00.000Z')
  })

  it('stores freshdesk stats timestamps', async () => {
    await syncTickets(fakeFd(), { since: '2026-10-19T00:00:00Z' })
    const t = await prisma.csTicket.findUnique({ where: { fdTicketId: 119 } })
    expect(t!.fdFirstRespondedAt?.toISOString()).toBe('2026-10-23T09:26:05.000Z')
    expect(t!.fdResolvedAt).toBeNull()
    expect(t!.closedAt).toBeNull()
  })

  it('counts a customer message after resolution as a reopen', async () => {
    const closed = tickets.map(t => (t.id === 195 ? { ...t, status: 5, stats: { resolved_at: '2026-10-23T15:00:00Z', closed_at: '2026-10-23T15:00:00Z' } } : t))
    const fd1 = fakeFd(); fd1.listTickets = async (_s: string, p = 1) => (p === 1 ? closed : []) as any
    await syncTickets(fd1, { since: '2026-10-19T00:00:00Z' })
    let t = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } })
    expect(t!.closedAt?.toISOString()).toBe('2026-10-23T15:00:00.000Z')
    expect(t!.reopenCount).toBe(0)
    const reopened = tickets.map(t => (t.id === 195 ? { ...t, status: 2, updated_at: '2026-10-24T08:00:00Z', stats: { resolved_at: '2026-10-23T15:00:00Z', closed_at: null } } : t))
    const fd2 = fakeFd(); fd2.listTickets = async (_s: string, p = 1) => (p === 1 ? reopened : []) as any
    fd2.getConversations = async (id: number) => (id === 195 ? [{ id: 9195, incoming: true, private: false, user_id: 1, body: '<p>still waiting</p>', body_text: 'still waiting', created_at: '2026-10-24T07:59:00Z' }] : []) as any
    await syncTickets(fd2, { since: '2026-10-19T00:00:00Z' })
    t = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } })
    expect(t!.reopenCount).toBe(1)
    expect(t!.closedAt).toBeNull()
  })

  it('counts one reopen when the ticket is re-resolved before the next sync, and not again later', async () => {
    const closed = tickets.map(t => (t.id === 195 ? { ...t, status: 5, stats: { resolved_at: '2026-10-23T15:00:00Z' } } : t))
    const fd1 = fakeFd(); fd1.listTickets = async (_s: string, p = 1) => (p === 1 ? closed : []) as any
    await syncTickets(fd1, { since: '2026-10-19T00:00:00Z' })
    const reclosed = tickets.map(t => (t.id === 195 ? { ...t, status: 4, updated_at: '2026-10-24T09:00:00Z', stats: { resolved_at: '2026-10-24T08:30:00Z', reopened_at: '2026-10-24T08:00:00Z' } } : t))
    const fd2 = fakeFd(); fd2.listTickets = async (_s: string, p = 1) => (p === 1 ? reclosed : []) as any
    fd2.getConversations = async (id: number) => (id === 195 ? [{ id: 9196, incoming: true, private: false, user_id: 1, body: '<p>not fixed</p>', body_text: 'not fixed', created_at: '2026-10-24T08:00:00Z' }] : []) as any
    await syncTickets(fd2, { since: '2026-10-19T00:00:00Z' })
    let t = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } })
    expect(t!.reopenCount).toBe(1)
    expect(t!.closedAt?.toISOString()).toBe('2026-10-24T08:30:00.000Z')
    const fd3 = fakeFd(); fd3.listTickets = async (_s: string, p = 1) => (p === 1 ? reclosed.map(x => (x.id === 195 ? { ...x, updated_at: '2026-10-24T10:00:00Z' } : x)) : []) as any
    fd3.getConversations = fd2.getConversations
    await syncTickets(fd3, { since: '2026-10-19T00:00:00Z' })
    t = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } })
    expect(t!.reopenCount).toBe(1)
  })

  it('uses the stored cursor and defaults', async () => {
    expect(DEFAULT_CS_SETTINGS.syncUpdatedSince).toBeNull()
    const fd = fakeFd()
    const res = await syncTickets(fd)
    expect(fd.calls[0]).toBe('list:1')
    expect(res.cursor).toBe('2026-10-23T14:39:58Z')
    const settings = await prisma.appSetting.findUnique({ where: { key: 'cs.settings' } })
    expect(JSON.parse(settings!.value).syncUpdatedSince).toBe('2026-10-23T14:39:58Z')
  })
})
