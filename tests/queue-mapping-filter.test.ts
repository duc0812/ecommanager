import { describe, expect, it } from 'vitest'
import { classifyMapping } from '@/lib/mapping-state'
import { matchesQueueFilter, needsArtwork } from '@/app/design-studio/components/model'

describe('classifyMapping', () => {
  it('a mapped line is ready only with a print template', () => {
    expect(classifyMapping({ resolvedSupplierId: 's', hasTemplate: true, typeHint: null })).toEqual({ state: 'READY', hint: null })
    expect(classifyMapping({ resolvedSupplierId: 's', hasTemplate: false, typeHint: 'X' })).toEqual({ state: 'NO_TEMPLATE', hint: null })
  })
  it('an unmapped line is UNMAPPED when its type has a templated supplier, else NO_TEMPLATE', () => {
    expect(classifyMapping({ resolvedSupplierId: null, hasTemplate: false, typeHint: 'Mangoshao · Fleece blanket' })).toEqual({ state: 'UNMAPPED', hint: 'Mangoshao · Fleece blanket' })
    expect(classifyMapping({ resolvedSupplierId: null, hasTemplate: false, typeHint: null })).toEqual({ state: 'NO_TEMPLATE', hint: null })
  })
})

describe('queue chips', () => {
  const task = (over: Record<string, unknown> = {}) => ({ readiness: 'MANUAL', status: 'NEW', hasPrint: false, mapping: 'READY', fromLibrary: false, unmapped: false, ...over }) as any
  it('Làm tay / Cần chỉnh / Auto hold only lines with supplier and template', () => {
    expect(matchesQueueFilter(task(), 'MANUAL', false)).toBe(true)
    expect(matchesQueueFilter(task({ mapping: 'UNMAPPED', unmapped: true }), 'MANUAL', false)).toBe(false)
    expect(matchesQueueFilter(task({ readiness: 'LOW', mapping: 'NO_TEMPLATE' }), 'LOW', false)).toBe(false)
    expect(matchesQueueFilter(task({ readiness: 'AUTO' }), 'AUTO', false)).toBe(true)
  })
  it('each line answers to exactly one of the five work chips', () => {
    const lines = [task(), task({ readiness: 'LOW' }), task({ readiness: 'AUTO' }), task({ mapping: 'UNMAPPED' }), task({ readiness: 'LOW', mapping: 'NO_TEMPLATE' })]
    for (const t of lines) {
      expect((['AUTO', 'LOW', 'MANUAL', 'UNMAPPED', 'NO_TEMPLATE'] as const).filter(f => matchesQueueFilter(t, f, false))).toHaveLength(1)
    }
  })
  it('Duyệt mẫu keeps readiness chips as they were', () => {
    expect(matchesQueueFilter(task({ readiness: 'LOW', status: 'REVIEW', mapping: 'NO_TEMPLATE' }), 'LOW', true)).toBe(true)
  })
  it('a line missing its template does not ask for artwork', () => {
    expect(needsArtwork(task())).toBe(true)
    expect(needsArtwork(task({ mapping: 'NO_TEMPLATE' }))).toBe(false)
  })
})
