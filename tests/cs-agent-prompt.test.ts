import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '@/lib/cs/agent-prompt'
import type { OrderContext } from '@/lib/cs/order-context'

const settings = { productionDays: 5, shippingDays: 15 }

describe('buildSystemPrompt', () => {
  it('carries brand rules and POD facts', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of [
      'believe the customer', 'where it is wrong', 'never ask for a photo as proof', 'made to order', '5 business days', '7–15 days',
      'before the order is handed to the factory', 'refund', 'citedcaseids', 'vietnamese', 'english', 'litzzy support',
    ]) expect(s, needle).toContain(needle)
    expect(s).toContain('(empty')
  })
  it('lists cases with ids and forbidden lines', () => {
    const s = buildSystemPrompt([{ id: 'c1', title: 'Late parcel', category: 'ORDER_STATUS', situation: 'Parcel late by 5+ days', resolution: 'Apologise, give tracking, offer 10% code', toneNotes: null, forbidden: 'never promise a refund', exampleReply: null, active: true } as any], settings)
    expect(s).toContain('[c1] Late parcel — ORDER_STATUS')
    expect(s).toContain('never promise a refund')
    expect(s).not.toContain('(empty')
  })
})

describe('buildUserPrompt', () => {
  it('shows ticket, order and the thread in order, excluding nothing visible', () => {
    const order: OrderContext = {
      match: 'EXACT',
      candidates: ['#LIT4525'],
      order: {
        id: 'o1', shopifyOrderNumber: '#LIT4525', placedAt: new Date('2026-10-02T10:00:00Z'), customerName: 'Paul', customerEmail: 'p@x.com', shipTo: '12 Test St, Testville FL 00000, United States',
        factoryState: 'SHIPPED', supplierHandoffAt: new Date('2026-10-05T00:00:00Z'), pipelineStatus: 'EXPORTED',
        lines: [{ title: 'Family Ornament', variant: '3 people', qty: 1, customized: true }],
        shipments: [{ trackingNumber: 'SWX1', carrier: 'USPS', status: 'IN_TRANSIT', lastCheckpointAt: new Date('2026-10-20T00:00:00Z'), trackingUrl: 'https://litzzy.com/apps/trackingorder?nums=SWX1' }],
        designTaskStatuses: ['DONE'],
      },
    }
    const ticket = { id: 't1', fdTicketId: 119, subject: 'Wrong place', requesterEmail: 'p@x.com', requesterName: 'Paul', fdCreatedAt: new Date('2026-10-20T05:48:29Z') } as any
    const messages = [
      { author: 'CUSTOMER', private: false, bodyText: 'You are sending it to the wrong place', createdAt: new Date('2026-10-20T05:48:29Z') },
      { author: 'STAFF', private: true, bodyText: 'internal note', createdAt: new Date('2026-10-23T09:24:53Z') },
      { author: 'STAFF', private: false, bodyText: 'Here is your tracking', createdAt: new Date('2026-10-23T09:26:05Z') },
      { author: 'CUSTOMER', private: false, bodyText: 'Are you sending it to my cousin??', createdAt: new Date('2026-10-23T14:16:19Z') },
    ] as any
    const previous = [{ category: 'ORDER_STATUS', urgency: 'NORMAL', summary: 'Khách hỏi đơn' }] as any
    const p = buildUserPrompt({ ticket, messages, order, previous })
    expect(p).toContain('#119')
    expect(p).toContain('#LIT4525')
    expect(p).toContain('10/02/2026')
    expect(p).toContain('SHIPPED')
    expect(p).toContain('Testville')
    expect(p).toContain('SWX1')
    expect(p).toContain('[CUSTOMER 10/20/2026')
    expect(p).toContain('[STAFF 10/23/2026 09:24 private]')
    expect(p).toContain('Khách hỏi đơn')
    expect(p.indexOf('wrong place')).toBeLessThan(p.indexOf('my cousin'))
  })
  it('names candidates when the match is ambiguous', () => {
    const p = buildUserPrompt({ ticket: { id: 't', fdTicketId: 1, subject: 's', fdCreatedAt: new Date() } as any, messages: [], order: { match: 'AMBIGUOUS', order: null, candidates: ['#LIT1', '#LIT2'] }, previous: [] })
    expect(p).toContain('AMBIGUOUS')
    expect(p).toContain('#LIT1, #LIT2')
  })
})
