import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { computeTrendingNiches } from '@/lib/spy/trending'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

const DAY = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(new URL(req.url).searchParams.get('days') ?? '7', 10) || 7, 90)
  const since = new Date(Date.now() - 2 * days * DAY)

  const products = await prisma.spyProduct.findMany({
    where: { firstSeenAt: { gte: since } },
    select: { productType: true, firstSeenAt: true, store: { select: { domain: true } } },
  })
  const niches = computeTrendingNiches(products, { windowDays: days })

  const ads = await prisma.spyAd.findMany({
    orderBy: { lastSeenAt: 'desc' },
    take: 500,
    include: {
      advertiser: { select: { pageName: true } },
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })
  const now = new Date()
  const winningAds = ads
    .map(a => ({
      ...a,
      signals: {
        isNew: isNewAd(a.startDate, now),
        activeDays: activeDays(a.startDate, a.endDate, now),
        isLongRunning: isLongRunning(a, now),
        isScaling: isScaling(a.observations),
        isStopped: isStopped(a.observations),
      },
    }))
    .filter(a => a.signals.isLongRunning || a.signals.isScaling)
    .sort((x, y) => y.signals.activeDays - x.signals.activeDays)
    .slice(0, 100)

  return NextResponse.json({ niches, winningAds })
}
