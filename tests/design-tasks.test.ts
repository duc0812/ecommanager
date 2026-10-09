import { describe, it, expect } from 'vitest'
import { taskKeyFor, canTransition } from '@/lib/design-tasks'

describe('taskKeyFor', () => {
  it('strips # and joins with _', () => {
    expect(taskKeyFor('#LIT4545', 1)).toBe('LIT4545_1')
    expect(taskKeyFor('RMS1187', 2)).toBe('RMS1187_2')
  })
})

describe('canTransition', () => {
  const T = (...a: any[]) => canTransition(a[0], a[1], a[2])
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
    expect(T('REVIEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(false)
    expect(T('DOING', 'DONE', 'DESIGNER', 'AUTO')).toBe(false)
    expect(T('REVIEW', 'DONE', 'LEADER', 'AUTO')).toBe(true)
    expect(T('NEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(false)
    expect(T('REVIEW', 'REJECTED', 'LEADER')).toBe(true)
    expect(T('REVIEW', 'REJECTED', 'DESIGNER')).toBe(false)
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
