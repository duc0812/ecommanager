import { describe, it, expect } from 'vitest'
import { autoReplyGate, mentionsRefundAddressOrCancel, type GateInput } from '@/lib/cs/policy'

const now = new Date('2026-10-23T12:00:00Z')
const passing: GateInput = {
  settings: { autoReplyEnabled: true, autoReplyCategories: ['ORDER_STATUS'], autoReplyDailyCap: 30, killSwitch: false, productionDays: 5, shippingDays: 15 },
  category: 'ORDER_STATUS',
  sentiment: 'CALM',
  orderMatch: 'EXACT',
  customerMessageCount: 1,
  hasAnyReply: false,
  hasTracking: true,
  placedAt: new Date('2026-10-10T00:00:00Z'),
  now,
  textMentionsRefundAddressOrCancel: false,
  autoRepliesToday: 0,
  hasActiveCaseForCategory: false,
}

function blocked(patch: Partial<GateInput>, reason: string) {
  const r = autoReplyGate({ ...passing, ...patch })
  expect(r.allowed).toBe(false)
  expect(r.reasons.join(' ')).toContain(reason)
}

describe('autoReplyGate', () => {
  it('passes the reference input', () => {
    expect(autoReplyGate(passing)).toEqual({ allowed: true, reasons: [] })
  })
  it('blocked when auto-reply is disabled', () => blocked({ settings: { ...passing.settings, autoReplyEnabled: false } }, 'disabled'))
  it('blocked by the kill switch', () => blocked({ settings: { ...passing.settings, killSwitch: true } }, 'kill switch'))
  it('blocked when the category is not allowed', () => blocked({ category: 'WRONG_ITEM' }, 'category'))
  it('blocked on the second customer message', () => blocked({ customerMessageCount: 2 }, 'first message'))
  it('blocked when any reply exists', () => blocked({ hasAnyReply: true }, 'already replied'))
  it('blocked on an ambiguous order match', () => blocked({ orderMatch: 'AMBIGUOUS' }, 'order'))
  it('blocked on NONE order match', () => blocked({ orderMatch: 'NONE' }, 'order'))
  it('allowed on BY_EMAIL match', () => expect(autoReplyGate({ ...passing, orderMatch: 'BY_EMAIL' }).allowed).toBe(true))
  it('blocked when the customer is angry', () => blocked({ sentiment: 'ANGRY' }, 'sentiment'))
  it('blocked on a dispute threat', () => blocked({ sentiment: 'DISPUTE_THREAT' }, 'sentiment'))
  it('blocked when the text mentions refund, address or cancel', () => blocked({ textMentionsRefundAddressOrCancel: true }, 'refund'))
  it('blocked with no tracking and an order older than the promised window', () =>
    blocked({ hasTracking: false, placedAt: new Date('2026-09-20T00:00:00Z') }, 'tracking'))
  it('allowed with no tracking inside the production + shipping window', () =>
    expect(autoReplyGate({ ...passing, hasTracking: false, placedAt: new Date('2026-10-21T00:00:00Z') }).allowed).toBe(true))
  it('blocked at the daily cap', () => blocked({ autoRepliesToday: 30 }, 'daily cap'))
  it('blocked for a non-baseline category without an active case', () =>
    blocked({ settings: { ...passing.settings, autoReplyCategories: ['ORDER_STATUS', 'PRODUCT_QUESTION'] }, category: 'PRODUCT_QUESTION' }, 'case'))
  it('allowed for a non-baseline category with an active case', () =>
    expect(autoReplyGate({ ...passing, settings: { ...passing.settings, autoReplyCategories: ['ORDER_STATUS', 'PRODUCT_QUESTION'] }, category: 'PRODUCT_QUESTION', hasActiveCaseForCategory: true }).allowed).toBe(true))
})

describe('mentionsRefundAddressOrCancel', () => {
  it('detects the risky phrases', () => {
    expect(mentionsRefundAddressOrCancel('please refund my money')).toBe(true)
    expect(mentionsRefundAddressOrCancel('I will file a chargeback')).toBe(true)
    expect(mentionsRefundAddressOrCancel('You are sending it to the wrong address')).toBe(true)
    expect(mentionsRefundAddressOrCancel('can I change the address?')).toBe(true)
    expect(mentionsRefundAddressOrCancel('cancel this order')).toBe(true)
  })
  it('ignores a plain status question', () => {
    expect(mentionsRefundAddressOrCancel('Where is my order? It has been a week.')).toBe(false)
  })
})
