import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getPeriodRange } from '@/lib/cashflow-dates'
import { getMetaRateSchedule } from '@/lib/meta-exchange-rates'
import { PROJECT_REVENUE_EXCLUDED_STATUSES } from '@/lib/project-metrics'
import { computeNichePerformance } from '@/lib/marketing/niche-performance'

export const dynamic = 'force-dynamic'

const PERIODS = new Set(['today', 'this-week', 'this-month', 'last-7', 'last-30', 'custom'])

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const periodRaw = searchParams.get('period') ?? 'this-month'
  const period = PERIODS.has(periodRaw) ? periodRaw : 'this-month'

  try {
    let projectId = searchParams.get('projectId')
    if (!projectId) {
      const first = await prisma.project.findFirst({ where: { archivedAt: null }, orderBy: { startDate: 'desc' }, select: { id: true } })
      projectId = first?.id ?? null
    }
    if (!projectId) return NextResponse.json({ error: 'No project found' }, { status: 404 })

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, shopifyStore: { select: { ianaTimezone: true } } },
    })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const timeZone = project.shopifyStore?.ianaTimezone ?? 'UTC'
    const { from, to, fromKey, toKey } = getPeriodRange(period, timeZone, searchParams.get('from'), searchParams.get('to'))

    const [niches, overrides, accounts, schedule] = await Promise.all([
      prisma.niche.findMany({ select: { id: true, name: true, keywords: true, active: true, sortOrder: true } }),
      prisma.metaCampaignNicheOverride.findMany({ select: { campaignId: true, nicheId: true } }),
      prisma.metaAdAccount.findMany({
        where: { projectId },
        select: { id: true, accountId: true, accountName: true, currency: true },
      }),
      getMetaRateSchedule(),
    ])

    const accountIds = accounts.map(a => a.id)
    const campaignSpends = accountIds.length > 0
      ? await prisma.metaCampaignDailySpend.findMany({
          where: { adAccountId: { in: accountIds }, date: { gte: fromKey, lte: toKey } },
          select: { adAccountId: true, campaignId: true, campaignName: true, date: true, spend: true, impressions: true, clicks: true, currency: true },
        })
      : []

    const orders = await prisma.order.findMany({
      where: {
        projectId,
        placedAt: { gte: from, lte: to },
        pipelineStatus: { notIn: [...PROJECT_REVENUE_EXCLUDED_STATUSES] },
      },
      select: {
        id: true,
        refundedAmount: true,
        lines: { select: { sku: true, productTitle: true, shopifyProductType: true, unitPrice: true, qty: true } },
      },
    })

    const result = computeNichePerformance({
      period: { from: fromKey, to: toKey, timeZone },
      niches,
      overrides,
      accounts,
      campaignSpends,
      orders,
      schedule,
    })

    return NextResponse.json({ project: { id: project.id, name: project.name }, ...result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
