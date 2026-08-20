import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('spy schema', () => {
  it('exposes all spy model delegates', () => {
    for (const m of ['spyStore','spyProduct','spyProductSnapshot','spyAdvertiser','spyAd','spyAdObservation','spyKeyword','spyKeywordHit','spyScan','spyIdea'] as const) {
      expect((prisma as any)[m]).toBeDefined()
    }
  })
})
