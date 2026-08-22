import { describe, it, expect } from 'vitest'
import { prisma } from '@/lib/db'

describe('SpyAdDomain schema', () => {
  it('exposes spyAdDomain and adDomainId relations', async () => {
    expect((prisma as any).spyAdDomain).toBeDefined()
    await expect(prisma.spyPageTarget.findMany({ select: { id: true, adDomainId: true }, take: 1 })).resolves.toBeDefined()
    await expect(prisma.spyAdvertiser.findMany({ select: { id: true, adDomainId: true }, take: 1 })).resolves.toBeDefined()
  })
})
