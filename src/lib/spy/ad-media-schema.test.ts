import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyAd.mediaUrl', () => {
  it('is a queryable field on the spyAd delegate', async () => {
    await expect(prisma.spyAd.findMany({ select: { id: true, mediaUrl: true }, take: 1 })).resolves.toBeDefined()
  })
})
