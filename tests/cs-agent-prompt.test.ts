import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '@/lib/cs/agent-prompt'
import type { OrderContext } from '@/lib/cs/order-context'

const settings = { productionDays: 5, shippingDays: 15 }

describe('buildSystemPrompt', () => {
  it('carries brand rules and POD facts', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    expect(buildSystemPrompt([], { productionDays: 5, shippingDays: 20 })).toContain('7–20 days')
    for (const needle of [
      'believe the customer', 'where it is wrong', 'never ask for a photo as proof', 'made to order', '5 business days', '7–15 days',
      'before the order is handed to the factory', 'refund', 'citedcaseids', 'vietnamese', 'english', 'litzzy support',
    ]) expect(s, needle).toContain(needle)
    expect(s).toContain('(empty')
  })
  it('reads the factory check of a suspect item: missing fulfillment is owned, a packed item is not called missing', () => {
    const s = buildSystemPrompt([], settings)
    expect(s).toContain('"NOT in parcel": the delivered parcel did not hold this item; our fulfillment is missing it')
    expect(s).toContain('The summary starts with "Fulfillment thiếu"')
    expect(s).toContain('"in parcel": the factory that shipped the parcel has this item')
    expect(s).toContain('Never promise a resend, refund or remake: staff decide')
  })
  it('fixes the reply structure: acknowledge, action with timing, closing promise within 24 hours', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## reply structure', 'first name', 'entirely our', 'put this right', 'frustrated, angry', 'calm', 'do not apologise', 'apologi', 'tracking', 'within 24 hours', 'follow', 'warm regards', '90', 'never open with "you'])
      expect(s, needle).toContain(needle)
  })
  it('carries the after-hours rules: carrier contact on stalled tracking, 24-hour confirmation', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## after-hours mode', 'sent to the customer automatically', 'never state an amount', 'contacting the carrier', 'within 24 hours', 'noted the new address', 'needshuman', 'missing case is never a reason', 'needs no answer', 'never ask the customer to repeat'])
      expect(s, needle).toContain(needle)
  })
  it('gives the agent no authority to offer a resend or refund without an admin decision', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## offers need approval', 'no authority', 'resend', 'refund', 'admin directive', 'library case', 'checking with my supervisor', 'within 24 hours'])
      expect(s, needle).toContain(needle)
    for (const gone of ['offer options', 'remake and send a replacement at no cost', 'keep the item with a partial credit', 'worth more than one reprint', 'offer them as options'])
      expect(s, gone).not.toContain(gone)
  })
  it('asks for patience on a parcel in transit, naming customs only as a possibility', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## late or stalled parcels', 'customs', 'may be', 'never state it as fact', 'able to wait', 'not yet shipped', 'delivered'])
      expect(s, needle).toContain(needle)
  })
  it('hands the ticket to a person when the customer asks for one or calls out the AI', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## customer asks for a person', 'humanrequested', 'real person', 'automated', 'a member of our support team will personally reply within 24 hours', 'never claim to be a person', 'no longer answers'])
      expect(s, needle).toContain(needle)
  })
  it('opens tasks for the team: third-party changes, refunds only once accepted, written in Vietnamese', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## tasks for the team', 'size_change', 'address_change', 'personalization_change', 'cancel_order', 'resend', 'carrier_check', 'supplier_error', 'verify_custom is opened by the system', 'personalisation on the order matches', 'refund', 'discount_code', 'only when the customer has accepted', 'in vietnamese', 'tasks is an empty list', 'amount is the agreed sum'])
      expect(s, needle).toContain(needle)
  })
  it('reads the answers to our verification email exactly as typed', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## answers to our verification email', 'customanswers', 'exactly as the customer typed', 'clear is true only when', 'customanswers is an empty list'])
      expect(s, needle).toContain(needle)
  })
  it('cancellations: ask the reason once, keep the customer in control, never argue', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## cancellation requests', 'what made them change their mind', 'holding it so nothing is made', 'one ask only', 'the question is mandatory', 'without asking', 'not our mistake', 'do not ask again', 'cancel as requested'])
      expect(s, needle).toContain(needle)
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
        lines: [{ title: 'Family Ornament', variant: '3 people', qty: 1, customized: true, personalization: 'Custom Name: Maree' }],
        shipments: [{ trackingNumber: 'SWX1', carrier: 'USPS', status: 'IN_TRANSIT', lastCheckpointAt: new Date('2026-10-20T00:00:00Z'), trackingUrl: 'https://litzzy.com/apps/trackingorder?nums=SWX1' }],
        designTaskStatuses: ['DONE'], items: [],
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
    expect(p).toContain('[personalised: Custom Name: Maree]')
    expect(p).toContain('[CUSTOMER 10/20/2026')
    expect(p).toContain('[STAFF 10/23/2026 09:24 private]')
    expect(p).toContain('Khách hỏi đơn')
    expect(p.indexOf('wrong place')).toBeLessThan(p.indexOf('my cousin'))
  })
  it('names the mode: after hours tells the model the draft goes out unattended, business hours that staff send it', () => {
    const ticket = { id: 't1', fdTicketId: 119, subject: 'Wrong place', requesterEmail: 'p@x.com', requesterName: 'Paul', fdCreatedAt: new Date('2026-10-20T05:48:29Z') } as any
    const base = { ticket, messages: [], order: { match: 'NONE', order: null, candidates: [] } as any, previous: [] }
    const night = buildUserPrompt({ ...base, mode: 'AFTER_HOURS' })
    expect(night).toContain('# Mode: AFTER_HOURS')
    expect(night.toLowerCase()).toContain('sent to the customer automatically')
    const day = buildUserPrompt({ ...base, mode: 'BUSINESS' })
    expect(day).toContain('# Mode: BUSINESS_HOURS')
    expect(day).not.toContain('AFTER_HOURS')
    expect(buildUserPrompt(base)).toContain('# Mode: BUSINESS_HOURS')
  })
  it('a review-origin ticket tells the agent never to raise the review', () => {
    const ticket = { id: 't1', fdTicketId: 119, subject: 'About your shirt', requesterEmail: 'p@x.com', requesterName: 'Paul', fdCreatedAt: new Date('2026-10-20T05:48:29Z') } as any
    const base = { ticket, messages: [], order: { match: 'NONE', order: null, candidates: [] } as any, previous: [] }
    const p = buildUserPrompt({ ...base, reviewOrigin: true })
    expect(p).toContain('# Origin')
    expect(p.toLowerCase()).toContain('never mention the star score')
    expect(buildUserPrompt(base)).not.toContain('# Origin')
  })
  it('shows the personalisation the customer typed on each line and tells the model to quote it, never guess', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['personalisation the customer typed', 'quote it exactly', 'never guess'])
      expect(s, needle).toContain(needle)
  })
  it('names candidates when the match is ambiguous', () => {
    const p = buildUserPrompt({ ticket: { id: 't', fdTicketId: 1, subject: 's', fdCreatedAt: new Date() } as any, messages: [], order: { match: 'AMBIGUOUS', order: null, candidates: ['#LIT1', '#LIT2'] }, previous: [] })
    expect(p).toContain('AMBIGUOUS')
    expect(p).toContain('#LIT1, #LIT2')
  })
})

describe('per-item order status (LIT4987)', () => {
  const item = (n: number, extra: Record<string, unknown> = {}) => ({
    lineKey: `LIT4987_${n}`, title: n === 1 ? 'Tumbler' : 'Zip Hoodie', variant: n === 1 ? '20oz' : '2XL', qty: 1, send: null, parcel: null, warning: null, ...extra,
  })
  const parcel = { trackingNumber: 'UL645924611YP', carrier: 'Yodel', status: 'DELIVERED', lastEvent: 'Delivered, handed to customer, NANTGARW', lastEventAt: new Date('2026-11-09T12:55:01Z'), deliveredAt: new Date('2026-11-09T12:55:01Z'), trackingUrl: null, fromSupplier: 'Mangoshao', sharedWith: [] as string[] }
  const order: OrderContext = {
    match: 'EXACT', candidates: ['#LIT4987'],
    order: {
      id: 'o', shopifyOrderNumber: '#LIT4987', placedAt: new Date('2026-10-15T00:00:00Z'), customerName: 'Eryl', customerEmail: 'e@x.com', shipTo: 'Abergavenny, GB',
      factoryState: 'DELIVERED', supplierHandoffAt: null, pipelineStatus: 'FULFILLED', lines: [], shipments: [], designTaskStatuses: [],
      items: [
        item(1, { parcel: { ...parcel, sharedWith: ['LIT4987_2'] }, warning: 'Không tìm được thông tin gửi xưởng mà sản phẩm đã gắn tracking UL645924611YP' }),
        item(2, { send: { supplier: 'Mangoshao', via: 'SHEET', ref: 'CN_POD_MS-20261028', sentAt: new Date('2026-10-28T01:52:59Z'), factoryStatus: null, checkedAt: null }, parcel: { ...parcel, sharedWith: ['LIT4987_1'] } }),
        item(3, { title: 'Mug', send: { supplier: 'Pgprints', via: 'API', ref: 'PG8160-1060', sentAt: new Date('2026-10-26T05:44:26Z'), factoryStatus: 'in-production', checkedAt: new Date('2026-11-07T20:30:00Z') } }),
      ],
    } as any,
  }
  const p = buildUserPrompt({ ticket: { id: 't', fdTicketId: 623, subject: 's', fdCreatedAt: new Date() } as any, messages: [], order, previous: [] })
  it('lists every item with its factory, how and when it was sent, and its parcel', () => {
    expect(p).toContain('items:')
    expect(p).toContain('LIT4987_1 Tumbler (20oz): sent: no record found')
    expect(p).toContain('LIT4987_2 Zip Hoodie (2XL): sent to Mangoshao by sheet CN_POD_MS-20261028 on 10/28/2026')
    expect(p).toContain('parcel UL645924611YP Yodel DELIVERED, delivered 10/09/2026'.replace('10/09', '11/09'))
    expect(p).toContain('latest scan 11/09/2026 "Delivered, handed to customer, NANTGARW"')
    expect(p).toContain('same parcel as LIT4987_1')
    expect(p).toContain('sent to Pgprints by API PG8160-1060 on 10/26/2026, factory status in-production (checked 11/07/2026); parcel: none yet')
    expect(p).toContain('WARNING: Không tìm được thông tin gửi xưởng')
  })
  it('tells the agent to read items first and never to call a warned item lost or our fault', () => {
    const s = buildSystemPrompt([], settings).toLowerCase()
    for (const needle of ['## items', 'each item', 'no record found', 'never guess', 'warning', 'separate parcel', 'do not say', 'entirely on us'])
      expect(s, needle).toContain(needle)
  })
})
