import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { prisma } from '@/lib/db'
import type { Llm } from '@/lib/llm/types'
import { buildRootCausePrompt, investigateTicket, needsInvestigation } from '@/lib/cs/root-cause'
import { buildOrderTimeline } from '@/lib/cs/timeline'

const PROJECT = 'cs-rc-project'
const SHOP = 'cs-rc.myshopify.com'
const ORDER = 'cs-rc-order'
const T0 = new Date('2026-10-01T10:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * 86400_000)
const settings = { productionDays: 5, shippingDays: 15 }

function fakeLlm(output: any) {
  const llm = {
    calls: 0,
    lastUser: '',
    async complete(i: any) { llm.calls += 1; llm.lastUser = i.user; return { output, tokensIn: 10, tokensOut: 5 } },
    async analyze(): Promise<any> { throw new Error('not used') },
  }
  return llm as Llm & { calls: number; lastUser: string }
}

async function mkTicket(fdId: number, category: string, orderId: string | null, orderMatch: string) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `rc ${fdId}`, fdStatus: 2, fdPriority: 1, category, orderId, orderNumber: orderId ? '#LIT8101' : null, orderMatch, fdCreatedAt: day(21), fdUpdatedAt: day(21), lastCustomerAt: day(21) } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `rc-${fdId}`, author: 'CUSTOMER', bodyText: 'The name on the mug says Laurence, I typed Laurance', createdAt: day(21) } })
  const a = await prisma.csAnalysis.create({ data: { ticketId: t.id, model: 'm', inputHash: 'h', outputJson: '{}', category, urgency: 'HIGH', sentiment: 'CALM', summary: 'Khách báo sai tên', proposal: 'In lại', needsHuman: true } })
  return { t, a }
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS rc', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.order.create({ data: { id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#LIT8101', customerEmail: 'rc@x.com', financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: T0, supplierHandoffAt: day(3), pipelineStatus: 'EXPORTED',
    lines: { create: [{ shopifyLineId: 'rc-l1', productTitle: 'Family Mug', qty: 1, unitPrice: 10, linePosition: 1, customized: true, customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Laurance' }]), designNote: 'approved: Laurance' }] },
    designTasks: { create: [{ shopifyLineId: 'rc-l1', taskKey: 'LIT8101_1', status: 'DONE', createdAt: day(0), updatedAt: day(2) }] },
    shipments: { create: [{ projectId: PROJECT, lineKey: '8101_1', trackingNumber: 'RC1', status: 'DELIVERED', lastCheckpointAt: day(15), checkpointsJson: JSON.stringify([{ time: day(8).toISOString(), desc: 'Picked up' }, { time: day(15).toISOString(), desc: 'Delivered' }]) }] },
  } })
})
beforeEach(async () => { await prisma.csTicket.deleteMany({}) })
afterAll(async () => { await prisma.csTicket.deleteMany({}); await prisma.order.deleteMany({ where: { id: ORDER } }) })

const rc = { stage: 'FACTORY', issueType: 'WRONG_TEXT', confidence: 'HIGH', evidence: 'File duyệt ghi Laurance, hàng in Laurence → xưởng in sai', affectedLineIds: ['rc-l1'] }

describe('root cause', () => {
  it('stores the root cause on the latest analysis and skips the second call', async () => {
    const { t } = await mkTicket(8101, 'WRONG_ITEM', ORDER, 'EXACT')
    const llm = fakeLlm(rc)
    const a = await investigateTicket(t.id, { llm, now: day(22) })
    expect(a.rootCauseStage).toBe('FACTORY')
    expect(a.issueType).toBe('WRONG_TEXT')
    expect(a.rootCauseConfidence).toBe('HIGH')
    expect(a.rootCauseAt).not.toBeNull()
    expect(JSON.parse(a.affectedLineIds)).toEqual(['rc-l1'])
    await investigateTicket(t.id, { llm, now: day(22) })
    expect(llm.calls).toBe(1)
  })
  it('writes UNKNOWN without calling the model when the order is unmatched', async () => {
    const { t } = await mkTicket(8102, 'WRONG_ITEM', null, 'NONE')
    const llm = fakeLlm(rc)
    const a = await investigateTicket(t.id, { llm, now: day(22) })
    expect(a.rootCauseStage).toBe('UNKNOWN')
    expect(llm.calls).toBe(0)
  })
  it('skips ORDER_STATUS tickets whose timeline is not late', async () => {
    const { t, a } = await mkTicket(8103, 'ORDER_STATUS', ORDER, 'EXACT')
    const timeline = await buildOrderTimeline(ORDER, settings, day(9))
    expect(needsInvestigation(a, t, timeline)).toBe('SKIP')
    expect(needsInvestigation({ ...a, category: 'ORDER_STATUS' }, t, await buildOrderTimeline(ORDER, { productionDays: 1, shippingDays: 15 }, day(9)))).toBe('RUN')
    expect(needsInvestigation({ ...a, category: 'PRODUCT_QUESTION' }, t, timeline)).toBe('SKIP')
    expect(needsInvestigation({ ...a, category: 'WRONG_ITEM' }, { ...t, orderMatch: 'NONE' }, null)).toBe('UNKNOWN')
    expect(needsInvestigation({ ...a, category: 'WRONG_ITEM', rootCauseAt: day(22) }, t, timeline)).toBe('SKIP')
  })
  it('prompt carries the gap flags and the customer inputs', async () => {
    const { t } = await mkTicket(8104, 'WRONG_ITEM', ORDER, 'EXACT')
    const llm = fakeLlm(rc)
    await investigateTicket(t.id, { llm, now: day(22) })
    expect(llm.lastUser).toContain('Name = "Laurance"')
    expect(llm.lastUser).toContain('production')
    expect(llm.lastUser).toContain('Laurence')
    const p = buildRootCausePrompt({ thread: 'x', timeline: 'y', category: 'WRONG_ITEM', summary: 's' })
    expect(p.system.toLowerCase()).toContain('fulfillment')
    expect(p.system).toContain('UNKNOWN')
  })
})
