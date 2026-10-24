import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import { analyzeTicket } from '@/lib/cs/analyze'
import type { Analysis } from '@/lib/cs/analysis-schema'
import type { Llm } from '@/lib/llm/anthropic'
import { saveCsSettings } from '@/lib/cs/settings'
import { LlmCapReached } from '@/lib/llm/cap'

const PROJECT = 'cs-an-project'
const SHOP = 'cs-an.myshopify.com'
const ORDER = 'cs-an-order-1'

function fakeLlm(output: Partial<Analysis>): Llm & { calls: number } {
  const base: Analysis = {
    category: 'ADDRESS_CHANGE', urgency: 'NORMAL', sentiment: 'ANGRY', orderNumber: '#LIT7001',
    summary: 'Khách báo gửi sai địa chỉ', facts: ['Địa chỉ mới: 12 Test St'], proposal: 'Đổi địa chỉ với xưởng ngay', citedCaseIds: [],
    draftReply: 'Hi Paul, we are on it.', needsHuman: true, needsHumanReason: 'address change', autoReplyEligible: false, autoReplyReason: 'address',
  }
  const llm = {
    calls: 0,
    async complete(): Promise<any> { throw new Error('complete not used here') },
    async analyze() { llm.calls += 1; return { output: { ...base, ...output }, tokensIn: 100, tokensOut: 50 } },
  }
  return llm
}

async function makeTicket(fdId: number, texts: string[]) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: 'Wrong place #LIT7001', requesterEmail: 'p@an.test', fdStatus: 2, fdPriority: 1, fdCreatedAt: new Date('2026-10-20T00:00:00Z'), fdUpdatedAt: new Date('2026-10-20T00:00:00Z') } })
  let i = 0
  for (const text of texts) {
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `an-${fdId}-${i++}`, author: 'CUSTOMER', bodyText: text, createdAt: new Date(Date.UTC(2026, 9, 20, 0, i)) } })
  }
  await prisma.csTicket.update({ where: { id: t.id }, data: { lastCustomerAt: new Date(Date.UTC(2026, 9, 20, 0, i)) } })
  return t
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS an', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.order.upsert({ where: { id: ORDER }, update: {}, create: {
    id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#LIT7001', customerEmail: 'p@an.test', financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: new Date('2026-10-18T00:00:00Z'),
  } })
})
beforeEach(async () => {
  await prisma.csTicket.deleteMany({})
  await prisma.csCase.deleteMany({})
  await prisma.appSetting.deleteMany({ where: { key: 'cs.settings' } })
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'cs.llmCalls.' } } })
})
afterAll(async () => {
  await prisma.csTicket.deleteMany({})
  await prisma.order.deleteMany({ where: { id: ORDER } })
})

describe('analyzeTicket', () => {
  it('honours the daily cap before calling the model', async () => {
    await saveCsSettings({ llmDailyCallCap: 0 })
    const t = await makeTicket(7020, ['hello'])
    const llm = fakeLlm({})
    await expect(analyzeTicket(t.id, { llm })).rejects.toBeInstanceOf(LlmCapReached)
    expect(llm.calls).toBe(0)
    expect((await prisma.csTicket.findUnique({ where: { id: t.id } }))!.lastAnalysisAt).toBeNull()
    await saveCsSettings({ llmDailyCallCap: 500 })
  })

  it('stores CsAnalysis with rule-raised urgency and updates the ticket', async () => {
    const t = await makeTicket(7001, ['You are sending it to the wrong place, it should go to 12 Test St'])
    const llm = fakeLlm({})
    const a = await analyzeTicket(t.id, { llm })
    expect(a.urgency).toBe('URGENT')
    expect(a.category).toBe('ADDRESS_CHANGE')
    expect(a.needsHuman).toBe(true)
    expect(a.tokensIn).toBe(100)
    const ticket = await prisma.csTicket.findUnique({ where: { id: t.id } })
    expect(ticket!.category).toBe('ADDRESS_CHANGE')
    expect(ticket!.urgency).toBe('URGENT')
    expect(ticket!.sentiment).toBe('ANGRY')
    expect(ticket!.orderId).toBe(ORDER)
    expect(ticket!.orderNumber).toBe('#LIT7001')
    expect(ticket!.orderMatch).toBe('EXACT')
    expect(ticket!.lastAnalysisAt).not.toBeNull()
    expect(ticket!.needsHuman).toBe(true)
  })

  it('skips the model when inputHash is unchanged', async () => {
    const t = await makeTicket(7002, ['hello'])
    const llm = fakeLlm({})
    const first = await analyzeTicket(t.id, { llm })
    const second = await analyzeTicket(t.id, { llm })
    expect(llm.calls).toBe(1)
    expect(second.id).toBe(first.id)
  })

  it('re-runs when a new customer message arrives', async () => {
    const t = await makeTicket(7003, ['hello'])
    const llm = fakeLlm({})
    await analyzeTicket(t.id, { llm })
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'an-7003-new', author: 'CUSTOMER', bodyText: 'anyone there?', createdAt: new Date('2026-10-21T00:00:00Z') } })
    await analyzeTicket(t.id, { llm })
    expect(llm.calls).toBe(2)
  })

  it('keeps the ticket needsHuman until a reply is actually sent, even when the gate allows', async () => {
    await saveCsSettings({ autoReplyEnabled: true })
    const t = await makeTicket(7010, ['Where is my order?'])
    const llm = fakeLlm({ category: 'ORDER_STATUS', sentiment: 'CALM', needsHuman: false, autoReplyEligible: true, draftReply: 'On its way.' })
    const a = await analyzeTicket(t.id, { llm, now: new Date('2026-10-23T00:00:00Z') })
    expect(JSON.parse(a.gateJson).allowed).toBe(true)
    expect((await prisma.csTicket.findUnique({ where: { id: t.id } }))!.needsHuman).toBe(true)
  })

  it('force re-analyses without new input', async () => {
    const t = await makeTicket(7011, ['hello'])
    const llm = fakeLlm({})
    await analyzeTicket(t.id, { llm })
    await analyzeTicket(t.id, { llm, force: true })
    expect(llm.calls).toBe(2)
  })

  it('measures the unanswered time from the first unanswered customer message', async () => {
    const t = await makeTicket(7012, ['Where is my order?', 'Hello? Anyone there?'])
    const llm = fakeLlm({ category: 'ORDER_STATUS', sentiment: 'CALM' })
    const a = await analyzeTicket(t.id, { llm, now: new Date('2026-10-21T08:00:00Z') })
    expect(a.urgency).toBe('HIGH')
  })

  it('does not persist the model guessed order number', async () => {
    const t = await makeTicket(7013, ['no number here'])
    await prisma.csTicket.update({ where: { id: t.id }, data: { subject: 'help', requesterEmail: 'nobody@an.test' } })
    const llm = fakeLlm({ orderNumber: '#LIT9999', category: 'OTHER' })
    await analyzeTicket(t.id, { llm })
    const ticket = await prisma.csTicket.findUnique({ where: { id: t.id } })
    expect(ticket!.orderNumber).toBeNull()
    expect(ticket!.orderMatch).toBe('NONE')
  })

  it('a dead tracking (EXPIRED) does not count as tracking for the gate', async () => {
    await saveCsSettings({ autoReplyEnabled: true })
    await prisma.shipment.create({ data: { orderId: ORDER, projectId: PROJECT, lineKey: '7001_1', trackingNumber: 'DEAD1', status: 'EXPIRED' } })
    const t = await makeTicket(7014, ['Where is my order?'])
    const llm = fakeLlm({ category: 'ORDER_STATUS', sentiment: 'CALM', needsHuman: false, autoReplyEligible: true, draftReply: 'On its way.' })
    const a = await analyzeTicket(t.id, { llm, now: new Date('2026-12-01T00:00:00Z') })
    expect(JSON.parse(a.gateJson).reasons.join(' ')).toContain('tracking')
    await prisma.shipment.deleteMany({ where: { orderId: ORDER } })
  })

  it('marks needsHuman when the model says eligible but the gate blocks', async () => {
    await saveCsSettings({ autoReplyEnabled: true })
    const t = await makeTicket(7004, ['Where is my order?'])
    const llm = fakeLlm({ category: 'ORDER_STATUS', sentiment: 'CALM', needsHuman: false, autoReplyEligible: true, draftReply: 'On its way.' })
    const a = await analyzeTicket(t.id, { llm, now: new Date('2026-10-23T00:00:00Z') })
    expect(a.autoReplyEligible).toBe(true)
    expect(a.needsHuman).toBe(false)
    const gate = JSON.parse(a.gateJson)
    expect(gate.allowed).toBe(true)
    await saveCsSettings({ autoReplyEnabled: false })
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'an-7004-x', author: 'CUSTOMER', bodyText: 'still waiting', createdAt: new Date('2026-10-22T00:00:00Z') } })
    const b = await analyzeTicket(t.id, { llm, now: new Date('2026-10-23T00:00:00Z') })
    const gate2 = JSON.parse(b.gateJson)
    expect(gate2.allowed).toBe(false)
    expect(gate2.reasons.join(' ')).toContain('disabled')
    expect((await prisma.csTicket.findUnique({ where: { id: t.id } }))!.needsHuman).toBe(true)
  })
})
