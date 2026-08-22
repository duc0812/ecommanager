import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyBestSeller schema', () => {
  it('exposes the spyBestSeller delegate', () => {
    expect(typeof prisma.spyBestSeller.findMany).toBe('function')
    expect(typeof prisma.spyBestSeller.create).toBe('function')
  })
})
