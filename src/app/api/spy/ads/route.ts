import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const ads = await prisma.spyAd.findMany({
    where: storeId ? { advertiser: { storeId } } : undefined,
    orderBy: { lastSeenAt: 'desc' },
    take: limit,
    include: { advertiser: { select: { pageName: true, storeId: true } }, observations: { select: { isActive: true, collationCount: true, observedAt: true } } },
  })

  const now = new Date()
  const enriched = ads.map(a => ({
    ...a,
    signals: {
      isNew: isNewAd(a.startDate, now),
      activeDays: activeDays(a.startDate, a.endDate, now),
      isLongRunning: isLongRunning(a, now),
      isScaling: isScaling(a.observations),
      isStopped: isStopped(a.observations),
    },
  }))

  const flags: Record<string, (x: typeof enriched[number]) => boolean> = {
    new: x => x.signals.isNew,
    'long-running': x => x.signals.isLongRunning,
    scaling: x => x.signals.isScaling,
    stopped: x => x.signals.isStopped,
  }
  const result = filter && flags[filter] ? enriched.filter(flags[filter]) : enriched
  return NextResponse.json({ ads: result })
}
