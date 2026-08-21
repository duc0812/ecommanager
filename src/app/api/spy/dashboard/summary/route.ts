import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isScaling, isLongRunning } from '@/lib/spy/ad-signals'
import { parseAdLink } from '@/lib/spy/ad-link'
import { recentLaunchSet } from '@/lib/spy/ad-product-match'

export async function GET() {
  const activeAds = await prisma.spyAd.count({ where: { isActive: true } })
  const ads = await prisma.spyAd.findMany({
    take: 500,
    orderBy: { lastSeenAt: 'desc' },
    select: {
      isActive: true, startDate: true, endDate: true, linkUrl: true,
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })
  const now = new Date()
  const scalingAds = ads.filter(a => isScaling(a.observations)).length
  const longRunningAds = ads.filter(a => isLongRunning(a, now)).length

  const launch = await recentLaunchSet(ads.map(a => a.linkUrl))
  const newLaunchingAds = ads.filter(a => {
    const p = parseAdLink(a.linkUrl)
    return p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
  }).length

  return NextResponse.json({ activeAds, newLaunchingAds, scalingAds, longRunningAds })
}
