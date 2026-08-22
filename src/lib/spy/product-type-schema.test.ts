import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyProductType schema', () => {
  it('exposes the spyProductType delegate', () => {
    expect(typeof prisma.spyProductType.findMany).toBe('function')
    expect(typeof prisma.spyProductType.upsert).toBe('function')
  })
})
