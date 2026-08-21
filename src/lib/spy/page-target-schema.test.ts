import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('spy page target schema', () => {
  it('exposes the spyPageTarget delegate', () => {
    expect((prisma as any).spyPageTarget).toBeDefined()
  })
})
