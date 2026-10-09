import { describe, it, expect } from 'vitest'
import { taskKeyFor, canTransition } from '@/lib/design-tasks'

describe('taskKeyFor', () => {
  it('strips # and joins with _', () => {
    expect(taskKeyFor('#LIT4545', 1)).toBe('LIT4545_1')
    expect(taskKeyFor('RMS1187', 2)).toBe('RMS1187_2')
  })
})

describe('canTransition', () => {
  const T = (f: any, t: any, a: any, r: any = 'LOW') => canTransition(f, t, a, r)
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
    expect(T('REVIEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(true)
    expect(T('NEW', 'DONE', 'DESIGNER', 'AUTO')).toBe(true)
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
})
