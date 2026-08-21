import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  const ad = await prisma.spyAd.findUnique({
    where: { id },
    include: { advertiser: true, observations: { orderBy: { observedAt: 'asc' } } },
  })
  if (!ad) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { rawPayload: _rawPayload, ...adNoRaw } = ad // eslint-disable-line @typescript-eslint/no-unused-vars
  const now = new Date()
  return NextResponse.json({
    ad: adNoRaw,
    signals: {
      isNew: isNewAd(ad.startDate, now),
      activeDays: activeDays(ad.startDate, ad.endDate, now),
      isLongRunning: isLongRunning(ad, now),
      isScaling: isScaling(ad.observations),
      isStopped: isStopped(ad.observations),
    },
  })
}
