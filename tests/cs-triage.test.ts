import { describe, it, expect } from 'vitest'
import { finalUrgency, ruleUrgency, tagsFor, urgencyToPriority } from '@/lib/cs/triage'

const calm = { sentiment: 'CALM' as const, hoursUnanswered: 0 }

describe('ruleUrgency', () => {
  it('address change before the factory is URGENT', () => {
    expect(ruleUrgency({ category: 'ADDRESS_CHANGE', factoryState: 'NOT_SENT', ...calm })).toBe('URGENT')
  })
  it('address change after shipping is HIGH', () => {
    expect(ruleUrgency({ category: 'ADDRESS_CHANGE', factoryState: 'SHIPPED', ...calm })).toBe('HIGH')
  })
  it('cancel with unknown factory state is URGENT', () => {
    expect(ruleUrgency({ category: 'CANCEL_ORDER', factoryState: null, ...calm })).toBe('URGENT')
  })
  it('wrong item is HIGH', () => {
    expect(ruleUrgency({ category: 'WRONG_ITEM', factoryState: 'DELIVERED', ...calm })).toBe('HIGH')
  })
  it('a dispute threat raises an order status question to HIGH', () => {
    expect(ruleUrgency({ category: 'ORDER_STATUS', factoryState: 'SHIPPED', sentiment: 'DISPUTE_THREAT', hoursUnanswered: 0 })).toBe('HIGH')
  })
  it('calm order status is NORMAL', () => {
    expect(ruleUrgency({ category: 'ORDER_STATUS', factoryState: 'SHIPPED', ...calm })).toBe('NORMAL')
  })
  it('spam is LOW', () => {
    expect(ruleUrgency({ category: 'SPAM', factoryState: null, ...calm })).toBe('LOW')
  })
  it('waiting more than 24h bumps one level', () => {
    expect(ruleUrgency({ category: 'ORDER_STATUS', factoryState: 'SHIPPED', sentiment: 'CALM', hoursUnanswered: 30 })).toBe('HIGH')
  })
})

describe('finalUrgency / priority / tags', () => {
  it('model can only raise, never lower', () => {
    expect(finalUrgency('NORMAL', 'URGENT')).toBe('URGENT')
    expect(finalUrgency('URGENT', 'NORMAL')).toBe('URGENT')
  })
  it('maps urgency to Freshdesk priority', () => {
    expect(urgencyToPriority('URGENT')).toBe(4)
    expect(urgencyToPriority('HIGH')).toBe(3)
    expect(urgencyToPriority('NORMAL')).toBe(2)
    expect(urgencyToPriority('LOW')).toBe(1)
  })
  it('replaces our em- tags and keeps the rest', () => {
    expect(tagsFor('ADDRESS_CHANGE', 'URGENT', ['shadow-email-ai-agent', 'em-order-status'])).toEqual(['shadow-email-ai-agent', 'em-address-change', 'em-urgent'])
    expect(tagsFor('ORDER_STATUS', 'NORMAL', ['em-urgent'])).toEqual(['em-order-status'])
  })
})
