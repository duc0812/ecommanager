import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeTrendingNiches } from '@/lib/spy/trending'
import { isScaling } from '@/lib/spy/ad-signals'

const DAY = 24 * 60 * 60 * 1000

export async function GET() {
  const since7 = new Date(Date.now() - 7 * DAY)
  const since14 = new Date(Date.now() - 14 * DAY)

  const [newProducts7d, activeAds, products, adsForScaling] = await Promise.all([
    prisma.spyProduct.count({ where: { firstSeenAt: { gte: since7 } } }),
    prisma.spyAd.count({ where: { isActive: true } }),
    prisma.spyProduct.findMany({ where: { firstSeenAt: { gte: since14 } }, select: { productType: true, firstSeenAt: true } }),
    prisma.spyAd.findMany({ take: 500, orderBy: { lastSeenAt: 'desc' }, select: { observations: { select: { isActive: true, collationCount: true, observedAt: true } } } }),
  ])

  const scalingAds = adsForScaling.filter(a => isScaling(a.observations)).length
  const trendingNiches = computeTrendingNiches(products, { windowDays: 7 }).length

  return NextResponse.json({ newProducts7d, activeAds, scalingAds, trendingNiches })
}
