import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'
import { parseAdLink } from '@/lib/spy/ad-link'
import { recentLaunchSet } from '@/lib/spy/ad-product-match'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const domainId = searchParams.get('domainId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const ads = await prisma.spyAd.findMany({
    where: {
      ...(storeId ? { advertiser: { storeId } } : {}),
      ...(domainId ? { advertiser: { adDomainId: domainId } } : {}),
    },
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    include: {
      advertiser: { select: { pageName: true, storeId: true } },
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })

  const launch = await recentLaunchSet(ads.map(a => a.linkUrl))
  const now = new Date()
  const enriched = ads.map(a => {
    const p = parseAdLink(a.linkUrl)
    const newProductLaunching = p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
    const { rawPayload: _rawPayload, ...rest } = a // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      ...rest,
      signals: {
        isNew: isNewAd(a.startDate, now),
        activeDays: activeDays(a.startDate, a.endDate, now),
        isLongRunning: isLongRunning(a, now),
        isScaling: isScaling(a.observations),
        isStopped: isStopped(a.observations),
        adStyle: p.kind,
        newProductLaunching,
      },
    }
  })

  const flags: Record<string, (x: typeof enriched[number]) => boolean> = {
    active: x => x.isActive,
    new: x => x.signals.isNew,
    'long-running': x => x.signals.isLongRunning,
    scaling: x => x.signals.isScaling,
    stopped: x => x.signals.isStopped,
  }
  const result = filter && flags[filter] ? enriched.filter(flags[filter]) : enriched
  return NextResponse.json({ ads: result })
}
