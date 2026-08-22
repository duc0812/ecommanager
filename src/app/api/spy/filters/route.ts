import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { bareDomain } from '@/lib/spy/domain-filter'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [stores, adDomains, niches, productTypes] = await Promise.all([
    prisma.spyStore.findMany({ select: { domain: true } }),
    prisma.spyAdDomain.findMany({ select: { domain: true } }),
    prisma.spyNiche.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.spyProductType.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const domainSet = new Set<string>()
  for (const s of stores) { const d = bareDomain(s.domain); if (d) domainSet.add(d) }
  for (const a of adDomains) { const d = bareDomain(a.domain); if (d) domainSet.add(d) }
  const domains = Array.from(domainSet).sort()
  return NextResponse.json({ domains, niches, productTypes })
}
