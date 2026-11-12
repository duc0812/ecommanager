import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { analyzeTicket } from '@/lib/cs/analyze'
import { ticketDetail } from '@/lib/cs/queries'
import type { Analysis } from '@/lib/cs/analysis-schema'

const PROJECT = 'cs-fc-project'
const SHOP = 'cs-fc.myshopify.com'
const ORDER = 'cs-fc-order'

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS fc', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { id: 'cs-fc-a' }, create: { id: 'cs-fc-a', name: 'Fc Mango', code: 'CSFCA' }, update: {} })
  await prisma.supplier.upsert({ where: { id: 'cs-fc-b' }, create: { id: 'cs-fc-b', name: 'Fc Pg', code: 'CSFCB' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#LIT7301', customerEmail: 's@fc.test', financialStatus: 'PAID', currency: 'USD', grossAmount: 90, expectedPayout: 80, placedAt: new Date('2026-10-26T00:00:00Z'),
    lines: { create: [
      { shopifyLineId: 'fc-1', productTitle: 'Tumbler', variantTitle: '30oz', qty: 1, unitPrice: 40, linePosition: 1, exportedToSupplierId: 'cs-fc-a', exportedAt: new Date('2026-10-29T03:00:00Z') },
      { shopifyLineId: 'fc-2', productTitle: 'Tumbler', variantTitle: '20oz', qty: 1, unitPrice: 40, linePosition: 2, exportedToSupplierId: 'cs-fc-b', exportedAt: new Date('2026-10-30T03:00:00Z') },
    ] },
    shipments: { create: [
      { projectId: PROJECT, lineKey: 'LIT7301_1', shopifyLineId: 'fc-1', trackingNumber: 'ULFC1', status: 'DELIVERED', supplierId: 'cs-fc-a' },
      { projectId: PROJECT, lineKey: 'LIT7301_2', shopifyLineId: 'fc-2', trackingNumber: 'ULFC1', status: 'DELIVERED', supplierId: 'cs-fc-a' },
    ] },
  } })
})
afterAll(async () => {
  await prisma.csTicket.deleteMany({ where: { fdTicketId: 73010 } })
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.supplier.deleteMany({ where: { id: { in: ['cs-fc-a', 'cs-fc-b'] } } })
})

describe('factory check in the analysis', () => {
  it('checks the suspect item, tells the model and keeps the result for the note and the panel', async () => {
    const t = await prisma.csTicket.create({ data: { fdTicketId: 73010, subject: 'Missing tumbler #LIT7301', requesterEmail: 's@fc.test', fdStatus: 2, fdPriority: 1, fdCreatedAt: new Date('2026-11-11T00:00:00Z'), fdUpdatedAt: new Date('2026-11-11T00:00:00Z') } })
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'fc-0', author: 'CUSTOMER', bodyText: 'I did not receive the 20oz', createdAt: new Date('2026-11-11T00:01:00Z') } })
    const prompts: string[] = []
    const llm = {
      async complete(): Promise<any> { throw new Error('unused') },
      async analyze(i: { user: string }) {
        prompts.push(i.user)
        const output: Analysis = { category: 'MISSING_ITEM', urgency: 'HIGH', sentiment: 'CALM', orderNumber: '#LIT7301', summary: 's', facts: [], proposal: 'p', citedCaseIds: [], draftReply: 'Hi', needsHuman: true, needsHumanReason: '', autoReplyEligible: false, autoReplyReason: '', humanRequested: false, tasks: [], customAnswers: [] }
        return { output, tokensIn: 1, tokensOut: 1 }
      },
    }
    const asked: string[] = []
    const lookup = async (supplier: string) => { asked.push(supplier); return { supplier, found: false, detail: supplier === 'Fc Mango' ? 'chỉ có LIT7301_1' : 'API không có đơn LIT7301' } }
    const a = await analyzeTicket(t.id, { llm: llm as any, lookup })
    expect(asked).toEqual(['Fc Pg', 'Fc Mango'])
    expect(prompts[0]).toContain('LIT7301_2 Tumbler (20oz)')
    expect(prompts[0]).toContain('FACTORY CHECK: NOT in parcel ULFC1')
    expect(JSON.parse(a.outputJson).factoryChecks).toEqual([expect.objectContaining({ lineKey: 'LIT7301_2', verdict: 'NOT_IN_PARCEL' })])
    const d = await ticketDetail(t.id)
    expect(d!.order.order!.items[1].check).toMatchObject({ verdict: 'NOT_IN_PARCEL' })
    expect(d!.order.order!.items[0].check ?? null).toBeNull()
  })
})
