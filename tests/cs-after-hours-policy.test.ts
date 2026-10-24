import { describe, it, expect } from 'vitest'
import { autoReplyGate, type GateInput } from '@/lib/cs/policy'

const now = new Date('2026-10-23T15:00:00Z')
const night: GateInput = {
  settings: { autoReplyEnabled: false, autoReplyCategories: ['ORDER_STATUS'], autoReplyDailyCap: 30, killSwitch: false, productionDays: 5, shippingDays: 15, afterHoursAutoReply: true, afterHoursCategories: ['ORDER_STATUS', 'DAMAGED_OR_DEFECTIVE', 'ADDRESS_CHANGE', 'REFUND_REQUEST', 'PRODUCT_QUESTION'] },
  mode: 'AFTER_HOURS',
  category: 'DAMAGED_OR_DEFECTIVE',
  sentiment: 'ANGRY',
  orderMatch: 'EXACT',
  customerMessageCount: 3,
  hasAnyReply: true,
  pendingCustomerMessage: true,
  hasTracking: false,
  placedAt: new Date('2026-08-01T00:00:00Z'),
  now,
  textMentionsRefundAddressOrCancel: true,
  autoRepliesToday: 0,
  autoRepliesOnTicket24h: 0,
  openDirectives: 0,
  hasActiveCaseForCategory: false,
}

function blocked(patch: Partial<GateInput>, reason: string) {
  const r = autoReplyGate({ ...night, ...patch })
  expect(r.allowed).toBe(false)
  expect(r.reasons.join(' ')).toContain(reason)
}

describe('autoReplyGate after hours', () => {
  it('allows a risky, angry, multi-message ticket with no tracking outside the window: the prompt rules carry it', () => {
    expect(autoReplyGate(night)).toEqual({ allowed: true, reasons: [], mode: 'AFTER_HOURS' })
  })
  it('blocked when the after-hours switch is off', () => blocked({ settings: { ...night.settings, afterHoursAutoReply: false } }, 'after-hours'))
  it('blocked by the kill switch', () => blocked({ settings: { ...night.settings, killSwitch: true } }, 'kill switch'))
  it('blocked when the category is not in the after-hours list', () => blocked({ category: 'OTHER' }, 'category'))
  it('blocked when no customer message is waiting', () => blocked({ pendingCustomerMessage: false }, 'waiting'))
  it('blocked on a dispute threat', () => blocked({ sentiment: 'DISPUTE_THREAT' }, 'sentiment'))
  it('blocked when the order is not found', () => blocked({ orderMatch: 'NONE' }, 'order'))
  it('allows a pre-sale question without an order', () => expect(autoReplyGate({ ...night, category: 'PRODUCT_QUESTION', orderMatch: 'NONE' }).allowed).toBe(true))
  it('blocked while an admin directive is open', () => blocked({ openDirectives: 1 }, 'directive'))
  it('blocked after two auto-replies on the ticket in 24h', () => blocked({ autoRepliesOnTicket24h: 2 }, 'twice'))
  it('blocked at the daily cap', () => blocked({ autoRepliesToday: 30 }, 'daily cap'))
  it('in BUSINESS mode the old strict gate still applies', () => {
    const r = autoReplyGate({ ...night, mode: 'BUSINESS' })
    expect(r.allowed).toBe(false)
    expect(r.mode).toBe('BUSINESS')
    expect(r.reasons.join(' ')).toContain('disabled')
  })
})
