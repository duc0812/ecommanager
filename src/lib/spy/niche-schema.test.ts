import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'
describe('SpyNiche schema', () => {
  it('exposes the spyNiche delegate', async () => {
    await expect(prisma.spyNiche.findMany({ take: 1 })).resolves.toBeDefined()
  })
})
