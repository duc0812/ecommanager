import { describe, it, expect } from 'vitest'
import { canTransition, dueForNewTask } from '@/lib/design-tasks'
import { lineKeysOf } from '@/lib/order-lines'

describe('lineKeysOf', () => {
  const line = (shopifyLineId: string, linePosition: number, productTitle: string, shopifyProductType: string | null = null) =>
    ({ shopifyLineId, linePosition, productTitle, shopifyProductType })

  it('strips # and numbers lines from 1', () => {
    expect(Array.from(lineKeysOf('#LIT4545', [line('a', 1, 'Tumbler')]).values())).toEqual(['LIT4545_1'])
  })

  it('counts product lines only, so an add-on before them shifts nothing (LIT5092)', () => {
    const keys = lineKeysOf('#LIT5092', [
      line('fee', 1, 'Custom Text TN915', 'Custom Text'),
      line('sweat', 2, 'Honey Bear Shirt'),
      line('tee', 3, 'Honey Bear Shirt'),
      line('tip', 4, 'Tip'),
    ])
    expect(keys.get('fee')).toBeUndefined()
    expect(keys.get('tip')).toBeUndefined()
    expect(keys.get('sweat')).toBe('LIT5092_1')
    expect(keys.get('tee')).toBe('LIT5092_2')
  })

  it('follows Shopify line order, not array order', () => {
    const keys = lineKeysOf('RMS1187', [line('b', 3, 'Mug'), line('x', 1, 'Shipping Protection'), line('a', 2, 'Shirt')])
    expect(keys.get('a')).toBe('RMS1187_1')
    expect(keys.get('b')).toBe('RMS1187_2')
  })
})

describe('canTransition', () => {
  const T = (...a: any[]) => canTransition(a[0], a[1], a[2], a[3])
  it('leader assigns, designer takes', () => {
    expect(T('NEW', 'ASSIGNED', 'LEADER')).toBe(true)
    expect(T('NEW', 'ASSIGNED', 'DESIGNER')).toBe(false)
    expect(T('NEW', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('ASSIGNED', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('ASSIGNED', 'NEW', 'DESIGNER')).toBe(true)
  })
  it('review flow', () => {
    expect(T('DOING', 'REVIEW', 'DESIGNER')).toBe(true)
    expect(T('REJECTED', 'REVIEW', 'DESIGNER')).toBe(true)
    expect(T('REVIEW', 'DONE', 'LEADER')).toBe(true)
    expect(T('REVIEW', 'DONE', 'DESIGNER')).toBe(false)
    expect(T('REVIEW', 'REJECTED', 'LEADER')).toBe(true)
    expect(T('REVIEW', 'REJECTED', 'DESIGNER')).toBe(false)
  })
  it('a designer holding the approve capability approves or returns a REVIEW task, and nothing else changes', () => {
    expect(T('REVIEW', 'DONE', 'DESIGNER', true)).toBe(true)
    expect(T('REVIEW', 'REJECTED', 'DESIGNER', true)).toBe(true)
    expect(T('REVIEW', 'DONE', 'DESIGNER', false)).toBe(false)
    expect(T('REVIEW', 'DONE', 'LEADER', false)).toBe(false)
    expect(T('NEW', 'ASSIGNED', 'DESIGNER', true)).toBe(false)
    expect(T('NEW', 'CANCELLED', 'DESIGNER', true)).toBe(false)
  })
  it('nobody skips REVIEW on the way to DONE', () => {
    for (const from of ['NEW', 'ASSIGNED', 'DOING', 'REJECTED', 'ASK_CUSTOMER']) {
      expect(T(from, 'DONE', 'DESIGNER', true)).toBe(false)
      expect(T(from, 'DONE', 'LEADER', true)).toBe(false)
      expect(T(from, 'REJECTED', 'DESIGNER', true)).toBe(false)
    }
  })
  it('ask customer from any open status, continue handled by service', () => {
    for (const s of ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']) expect(T(s, 'ASK_CUSTOMER', 'DESIGNER')).toBe(true)
    expect(T('DONE', 'ASK_CUSTOMER', 'DESIGNER')).toBe(false)
  })
  it('reopen and forbidden moves', () => {
    expect(T('DONE', 'DOING', 'DESIGNER')).toBe(true)
    expect(T('CANCELLED', 'DOING', 'LEADER')).toBe(false)
    expect(T('NEW', 'REVIEW', 'DESIGNER')).toBe(false)
  })
  it('cancel is leader-only and never from DONE', () => {
    expect(T('DONE', 'CANCELLED', 'LEADER')).toBe(false)
    expect(T('NEW', 'CANCELLED', 'LEADER')).toBe(true)
    expect(T('ASK_CUSTOMER', 'CANCELLED', 'LEADER')).toBe(true)
    expect(T('NEW', 'CANCELLED', 'DESIGNER')).toBe(false)
  })
})

describe('dueForNewTask', () => {
  const now = new Date('2026-10-13T00:00:00Z').getTime()
  it('counts the SLA from the order date while that deadline is still ahead', () => {
    expect(dueForNewTask(new Date('2026-10-12T20:00:00Z'), 24, now).toISOString()).toBe('2026-10-13T20:00:00.000Z')
  })
  it('gives a backlog order a full SLA from now', () => {
    expect(dueForNewTask(new Date('2026-10-05T00:00:00Z'), 24, now).toISOString()).toBe('2026-10-14T00:00:00.000Z')
  })
})
