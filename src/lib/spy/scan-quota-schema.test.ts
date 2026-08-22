import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'
describe('SpyScanQuota schema', () => {
  it('exposes the spyScanQuota delegate', () => {
    expect(typeof prisma.spyScanQuota.upsert).toBe('function')
    expect(typeof prisma.spyScanQuota.findUnique).toBe('function')
  })
})
