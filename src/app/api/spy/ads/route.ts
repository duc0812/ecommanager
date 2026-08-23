import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isNewAd, activeDays, isLongRunning, isScaling, isStopped } from '@/lib/spy/ad-signals'
import { parseAdLink } from '@/lib/spy/ad-link'
import { recentLaunchSet, productDateMap } from '@/lib/spy/ad-product-match'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'
import { domainVariants } from '@/lib/spy/domain-filter'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') || undefined
  const storeId = searchParams.get('storeId') || undefined
  const domainId = searchParams.get('domainId') || undefined
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 500)

  const and: any[] = []
  if (storeId) and.push({ advertiser: { storeId } })
  if (domainId) and.push({ advertiser: { adDomainId: domainId } })
  if (domain) {
    const v = domainVariants(domain)
    and.push({ advertiser: { OR: [{ store: { domain: { in: v } } }, { adDomain: { domain: { in: v } } }] } })
  }
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title', 'body'])
    if (nw) and.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title', 'body'])
    if (pw) and.push(pw)
  }
  const excludedRows = await prisma.spyPageTarget.findMany({ where: { excluded: true, fbPageId: { not: null } }, select: { fbPageId: true } })
  const excludedIds = excludedRows.map(r => r.fbPageId).filter((x): x is string => !!x)
  if (excludedIds.length) and.push({ advertiser: { fbPageId: { notIn: excludedIds } } })
  if (filter === 'new') and.push({ startDate: { gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) } })
  if (filter === 'winning' || filter === 'long-running') and.push({ startDate: { not: null } })
  const where: any = and.length ? { AND: and } : {}
  const orderBy = filter === 'winning' || filter === 'long-running' ? { startDate: 'asc' as const } : { startDate: 'desc' as const }

  const ads = await prisma.spyAd.findMany({
    where,
    orderBy,
    take: limit,
    include: {
      advertiser: { select: { pageName: true, storeId: true } },
      observations: { select: { isActive: true, collationCount: true, observedAt: true } },
    },
  })

  const launch = await recentLaunchSet(ads.map(a => a.resolvedUrl ?? a.linkUrl))
  const dates = await productDateMap(ads.map(a => a.resolvedUrl ?? a.linkUrl))
  const now = new Date()
  const enriched = ads.map(a => {
    const p = parseAdLink(a.resolvedUrl ?? a.linkUrl)
    const newProductLaunching = p.kind === 'product' && !!p.host && !!p.handle && launch.has(`${p.host}|${p.handle}`)
    const key = p.kind === 'product' && p.host && p.handle ? `${p.host}|${p.handle}` : null
    const { rawPayload: _rawPayload, ...rest } = a // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      ...rest,
      productPublishedAt: key && dates.has(key) ? dates.get(key) : null,
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
    launching: x => x.signals.newProductLaunching,
    winning: x => x.signals.isLongRunning || x.signals.isScaling,
  }
  const result = filter && flags[filter] ? enriched.filter(flags[filter]) : enriched
  return NextResponse.json({ ads: result })
}
