import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import type { FdConversation, FdTicket, FreshdeskClient } from '@/lib/cs/freshdesk'
import type { Analysis } from '@/lib/cs/analysis-schema'
import type { Llm } from '@/lib/llm/anthropic'
import { runAgentCycle } from '@/lib/cs/agent'
import { dailyDigest } from '@/lib/cs/actions'
import { saveCsSettings } from '@/lib/cs/settings'
import ticketsPage from './fixtures/cs/tickets-page.json'
import conversations119 from './fixtures/cs/conversations-119.json'

const tickets = ticketsPage as unknown as FdTicket[]
const conv119 = conversations119 as unknown as FdConversation[]
const PROJECT = 'cs-cycle-project'
const SHOP = 'cs-cycle.myshopify.com'
const ORDERS = ['cs-cycle-4525', 'cs-cycle-3910']

type Call = { kind: string; id: number; payload?: any }
function fakeFd(): FreshdeskClient & { calls: Call[] } {
  const calls: Call[] = []
  let replyId = 900
  let noteId = 800
  const fd: any = {
    calls,
    requests: 0,
    async listTickets(_s: string, page = 1) { fd.requests++; return page === 1 ? tickets : [] },
    async getConversations(id: number) { fd.requests++; return id === 119 ? conv119 : [] },
    async reply(id: number, body: string) { fd.requests++; calls.push({ kind: 'reply', id, payload: body }); return { id: replyId++ } },
    async note(id: number, body: string) { fd.requests++; calls.push({ kind: 'note', id, payload: body }); return { id: noteId++ } },
    async update(id: number, patch: any) { fd.requests++; calls.push({ kind: 'update', id, payload: patch }) },
  }
  return fd
}

const base: Analysis = {
  category: 'ORDER_STATUS', urgency: 'NORMAL', sentiment: 'CALM', orderNumber: null, summary: 'Khách hỏi đơn đến đâu', facts: [], proposal: 'Gửi tracking',
  citedCaseIds: [], draftReply: 'Hi, your order is on its way.\n\nLitzzy Support', needsHuman: false, needsHumanReason: '', autoReplyEligible: true, autoReplyReason: 'first wismo',
}
function fakeLlm(): Llm & { calls: number } {
  const llm = {
    calls: 0,
    async analyze({ user }: { user: string }) {
      llm.calls++
      const output: Analysis = user.includes('Ticket #119')
        ? { ...base, category: 'ADDRESS_CHANGE', urgency: 'HIGH', sentiment: 'ANGRY', orderNumber: '#LIT4525', summary: 'Khách báo gửi sai địa chỉ', facts: ['Địa chỉ mới: 12 Test St'], proposal: 'Liên hệ carrier đổi địa chỉ', draftReply: null, needsHuman: true, needsHumanReason: 'address', autoReplyEligible: false }
        : user.includes('Ticket #195')
          ? { ...base, orderNumber: '#LIT3910' }
          : { ...base, orderNumber: '#LIT5037', needsHuman: true, autoReplyEligible: false, draftReply: null }
      return { output, tokensIn: 10, tokensOut: 5 }
    },
  }
  return llm
}

function collector() {
  const texts: string[] = []
  return { texts, notifier: async (t: string) => { texts.push(t) } }
}

async function clean() {
  await prisma.csTicket.deleteMany({})
  await prisma.csAgentRun.deleteMany({})
  await prisma.csCase.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: { in: ['cs.settings', 'last_cs_run_result'] } } })
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS cycle', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  const order = (id: string, number: string, email: string) => ({ id, projectId: PROJECT, storeId, shopifyOrderNumber: number, customerEmail: email, financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: new Date('2026-10-10T00:00:00Z') })
  await prisma.order.upsert({ where: { id: ORDERS[0] }, update: {}, create: { ...order(ORDERS[0], '#LIT4525', 'paul.test@example.com'), pipelineStatus: 'EXPORTED', supplierHandoffAt: new Date('2026-10-12T00:00:00Z'),
    shipments: { create: [{ projectId: PROJECT, lineKey: '4525_1', trackingNumber: 'SWX664', status: 'IN_TRANSIT' }] } } })
  await prisma.order.upsert({ where: { id: ORDERS[1] }, update: {}, create: { ...order(ORDERS[1], '#LIT3910', 'dave.test@example.com'), pipelineStatus: 'EXPORTED',
    shipments: { create: [{ projectId: PROJECT, lineKey: '3910_1', trackingNumber: 'SWX391', status: 'IN_TRANSIT' }] } } })
})
beforeEach(clean)
afterAll(async () => { await clean(); await prisma.order.deleteMany({ where: { id: { in: ORDERS } } }) })

const deps = () => ({ fd: fakeFd(), llm: fakeLlm(), appUrl: 'http://app.test', now: new Date('2026-10-23T15:00:00Z') })

describe('runAgentCycle', () => {
  it('full cycle: syncs, analyses changed tickets, writes back and notifies HIGH only', async () => {
    const d = deps()
    const { texts, notifier } = collector()
    const run = await runAgentCycle({ ...d, notifier })
    expect(run.error).toBeNull()
    expect(run.ticketsSeen).toBe(3)
    expect(run.analysed).toBe(3)
    expect(run.autoReplied).toBe(0)
    const update119 = d.fd.calls.find(c => c.kind === 'update' && c.id === 119)!
    expect(update119.payload.priority).toBe(3)
    expect(update119.payload.tags).toContain('em-address-change')
    expect(update119.payload.tags).toContain('em-high')
    expect(update119.payload.tags).toContain('shadow-email-ai-agent')
    const update195 = d.fd.calls.find(c => c.kind === 'update' && c.id === 195)!
    expect(update195.payload.custom_fields).toEqual({ cf_order_id: '#LIT3910' })
    expect(d.fd.calls.filter(c => c.kind === 'note')).toHaveLength(3)
    expect(d.fd.calls.find(c => c.kind === 'note' && c.id === 119)!.payload).toContain('http://app.test/cs/')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('#LIT4525')
    expect(texts[0]).toContain('HIGH')
    expect(d.fd.calls.filter(c => c.kind === 'reply')).toHaveLength(0)
    const t119 = await prisma.csTicket.findUnique({ where: { fdTicketId: 119 } })
    expect(t119!.needsHuman).toBe(true)
    expect(t119!.lastNoteHash).not.toBeNull()
  })

  it('auto-replies ticket 195 when settings allow and the gate passes', async () => {
    await saveCsSettings({ autoReplyEnabled: true })
    const d = deps()
    const run = await runAgentCycle({ ...d, notifier: collector().notifier })
    const replies = d.fd.calls.filter(c => c.kind === 'reply')
    expect(replies).toHaveLength(1)
    expect(replies[0].id).toBe(195)
    expect(replies[0].payload).toContain('<p>Hi, your order is on its way.</p>')
    const t = await prisma.csTicket.findUnique({ where: { fdTicketId: 195 }, include: { messages: true } })
    expect(t!.autoReplied).toBe(true)
    expect(t!.needsHuman).toBe(false)
    const agentMsg = t!.messages.find(m => m.author === 'AGENT')!
    expect(agentMsg.fdConversationId).toBe('900')
    const statusUpdate = d.fd.calls.find(c => c.kind === 'update' && c.id === 195 && c.payload.status === 6)
    expect(statusUpdate).toBeDefined()
    expect(statusUpdate!.payload.tags).toContain('em-auto-replied')
    expect(run.autoReplied).toBe(1)
  })

  it('does not auto-reply when autoReplyEnabled is false', async () => {
    const d = deps()
    await runAgentCycle({ ...d, notifier: collector().notifier })
    expect(d.fd.calls.filter(c => c.kind === 'reply')).toHaveLength(0)
    expect((await prisma.csTicket.findUnique({ where: { fdTicketId: 195 } }))!.needsHuman).toBe(true)
  })

  it('re-run with no changes posts no second note and no second telegram', async () => {
    const d = deps()
    const { texts, notifier } = collector()
    await runAgentCycle({ ...d, notifier })
    const notesBefore = d.fd.calls.filter(c => c.kind === 'note').length
    const run2 = await runAgentCycle({ ...d, notifier }, { force: true })
    expect(run2.analysed).toBe(0)
    expect(d.fd.calls.filter(c => c.kind === 'note').length).toBe(notesBefore)
    expect(texts).toHaveLength(1)
    expect(d.llm.calls).toBe(3)
  })

  it('runs without an llm: tickets sync, nothing is analysed, run has no error', async () => {
    const d = deps()
    const run = await runAgentCycle({ ...d, llm: null, notifier: collector().notifier })
    expect(run.error).toBeNull()
    expect(run.ticketsSeen).toBe(3)
    expect(run.analysed).toBe(0)
    expect(await prisma.csTicket.count()).toBe(3)
    expect(await prisma.csAnalysis.count()).toBe(0)
    const last = await prisma.appSetting.findUnique({ where: { key: 'last_cs_run_result' } })
    expect(JSON.parse(last!.value).ticketsSeen).toBe(3)
  })

  it('keeps going when one ticket analysis throws and records the error', async () => {
    const d = deps()
    const llm: Llm = { async analyze(i) { if (i.user.includes('Ticket #194')) throw new Error('boom'); return d.llm.analyze(i) } }
    const run = await runAgentCycle({ ...d, llm, notifier: collector().notifier })
    expect(run.analysed).toBe(2)
    expect(run.error).toContain('boom')
  })
})

describe('dailyDigest', () => {
  it('counts open needs-human tickets by urgency', async () => {
    const mk = (fdId: number, urgency: string) => prisma.csTicket.create({ data: { fdTicketId: fdId, subject: 's', fdStatus: 2, fdPriority: 1, urgency, needsHuman: true, fdCreatedAt: new Date(), fdUpdatedAt: new Date() } })
    await mk(1, 'URGENT'); await mk(2, 'URGENT'); await mk(3, 'NORMAL')
    await prisma.csTicket.create({ data: { fdTicketId: 4, subject: 'closed', fdStatus: 5, fdPriority: 1, urgency: 'URGENT', needsHuman: true, fdCreatedAt: new Date(), fdUpdatedAt: new Date() } })
    const { texts, notifier } = collector()
    expect(await dailyDigest(notifier, 'http://app.test')).toBe(true)
    expect(texts[0]).toContain('URGENT: 2')
    expect(texts[0]).toContain('NORMAL: 1')
    expect(texts[0]).not.toContain('URGENT: 3')
  })
  it('sends nothing when the queue is empty', async () => {
    const { texts, notifier } = collector()
    expect(await dailyDigest(notifier, 'http://app.test')).toBe(false)
    expect(texts).toHaveLength(0)
  })
})
