import { describe, expect, it } from 'vitest'
import { classifyMapping } from '@/lib/mapping-state'
import { matchesQueueFilter, needsArtwork } from '@/app/design-studio/components/model'
import { streamOf } from '@/app/design-studio/components/streams'

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
  it('a mapped line answers to exactly one readiness chip; an unmapped or template-less line to none — it lives in the Mapping / Template stream', () => {
    const chips = (t: any) => (['AUTO', 'LOW', 'MANUAL'] as const).filter(f => matchesQueueFilter(t, f, false))
    for (const t of [task(), task({ readiness: 'LOW' }), task({ readiness: 'AUTO' })]) expect(chips(t)).toHaveLength(1)
    const unmapped = task({ mapping: 'UNMAPPED' })
    const noTemplate = task({ readiness: 'LOW', mapping: 'NO_TEMPLATE' })
    expect(chips(unmapped)).toHaveLength(0)
    expect(chips(noTemplate)).toHaveLength(0)
    expect(streamOf(unmapped)).toBe('MAP')
    expect(streamOf(noTemplate)).toBe('TPL')
  })
  it('Duyệt mẫu keeps readiness chips as they were', () => {
    expect(matchesQueueFilter(task({ readiness: 'LOW', status: 'REVIEW', mapping: 'NO_TEMPLATE' }), 'LOW', true)).toBe(true)
  })
  it('a line missing its template does not ask for artwork', () => {
    expect(needsArtwork(task())).toBe(true)
    expect(needsArtwork(task({ mapping: 'NO_TEMPLATE' }))).toBe(false)
  })
})
