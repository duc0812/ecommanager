import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { listTickets, ticketDetail } from '@/lib/cs/queries'

const now = new Date('2026-10-23T15:00:00Z')
async function mk(fdId: number, patch: Partial<Parameters<typeof prisma.csTicket.create>[0]['data']>) {
  return prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `s${fdId}`, fdStatus: 2, fdPriority: 1, fdCreatedAt: now, fdUpdatedAt: now, needsHuman: true, ...patch } })
}

beforeAll(async () => {
  await prisma.csTicket.deleteMany({})
  await mk(1, { urgency: 'HIGH', lastCustomerAt: new Date('2026-10-23T10:00:00Z'), orderNumber: '#LIT1111', requesterEmail: 'one@x.com', category: 'WRONG_ITEM' })
  await mk(2, { urgency: 'URGENT', lastCustomerAt: new Date('2026-10-23T12:00:00Z'), requesterEmail: 'two@x.com' })
  await mk(3, { urgency: 'URGENT', lastCustomerAt: new Date('2026-10-23T08:00:00Z'), requesterEmail: 'three@x.com' })
  await mk(4, { urgency: 'NORMAL', needsHuman: false, autoReplied: true, lastCustomerAt: now })
  await mk(5, { urgency: 'NORMAL', fdStatus: 5, lastCustomerAt: now })
  await mk(6, { urgency: 'NORMAL', resolvedInTool: true, lastCustomerAt: now })
  const t1 = await prisma.csTicket.findUnique({ where: { fdTicketId: 1 } })
  await prisma.csAnalysis.create({ data: { ticketId: t1!.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'CALM', summary: 'Sai màu áo', proposal: 'In lại', needsHuman: true } })
  await prisma.csMessage.create({ data: { ticketId: t1!.id, fdConversationId: 'q-1', author: 'CUSTOMER', bodyText: 'wrong colour', createdAt: new Date('2026-10-23T10:00:00Z') } })
})
afterAll(async () => { await prisma.csTicket.deleteMany({}) })

describe('listTickets', () => {
  it('todo sorts URGENT first, then oldest customer message first', async () => {
    const rows = await listTickets('todo', undefined, now)
    expect(rows.map(r => r.fdTicketId)).toEqual([3, 2, 1])
    expect(rows[2].summary).toBe('Sai màu áo')
    expect(rows[2].hoursUnanswered).toBe(5)
  })
  it('agent tab lists auto-replied tickets, done tab lists closed and resolved', async () => {
    expect((await listTickets('agent')).map(r => r.fdTicketId)).toEqual([4])
    expect((await listTickets('done')).map(r => r.fdTicketId).sort()).toEqual([5, 6])
  })
  it('q matches order number, requester email and subject', async () => {
    expect((await listTickets('todo', 'LIT1111')).map(r => r.fdTicketId)).toEqual([1])
    expect((await listTickets('todo', 'two@')).map(r => r.fdTicketId)).toEqual([2])
    expect((await listTickets('todo', 's3')).map(r => r.fdTicketId)).toEqual([3])
  })
})

describe('ticketDetail', () => {
  it('returns thread, latest analysis and order context', async () => {
    const t1 = await prisma.csTicket.findUnique({ where: { fdTicketId: 1 } })
    const d = await ticketDetail(t1!.id)
    expect(d!.messages).toHaveLength(1)
    expect(d!.analysis?.summary).toBe('Sai màu áo')
    expect(d!.order.match).toBe('NONE')
    expect(await ticketDetail('nope')).toBeNull()
  })
})
