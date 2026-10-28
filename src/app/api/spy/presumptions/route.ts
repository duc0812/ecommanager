import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'
import { domainVariants } from '@/lib/spy/domain-filter'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'
import { LEVELS, recomputePresumptions } from '@/lib/spy/presumptions'
import { runExclusive } from '@/lib/job-lock'

export const dynamic = 'force-dynamic'

// Strongest first, then the most recently flagged, then the newest product. The fired rule ids stay server-side: the page shows the level only.
const LEVEL_ORDER = [...LEVELS].reverse()

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const level = searchParams.get('level') || undefined
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10) || 200, 1000)

  const productAnd: any[] = []
  if (domain) productAnd.push({ store: { domain: { in: domainVariants(domain) } } })
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title'])
    if (nw) productAnd.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title'])
    if (pw) productAnd.push(pw)
  }
  const base = productAnd.length ? { product: { AND: productAnd } } : {}

  const grouped = await prisma.spyPresumption.groupBy({ by: ['level'], where: base, _count: { _all: true } })
  const counts: Record<string, number> = {}
  for (const g of grouped) counts[g.level] = g._count._all

  const levels = level && (LEVELS as readonly string[]).includes(level) ? [level] : LEVEL_ORDER
  const items: any[] = []
  for (const l of levels) {
    if (items.length >= limit) break
    const rows = await prisma.spyPresumption.findMany({
      where: { ...base, level: l },
      orderBy: [{ levelSince: 'desc' }, { product: { publishedAt: 'desc' } }],
      take: limit - items.length,
      select: {
        level: true,
        product: {
          select: {
            id: true, title: true, handle: true, imageUrl: true, priceMin: true, priceMax: true,
            firstSeenAt: true, productType: true, store: { select: { domain: true } },
          },
        },
      },
    })
    for (const r of rows) items.push({ ...r.product, level: r.level })
  }

  const latest = await prisma.spyPresumption.findFirst({ orderBy: { computedAt: 'desc' }, select: { computedAt: true } })
  return NextResponse.json({ items, counts, computedAt: latest?.computedAt ?? null })
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const outcome = await runExclusive('spy:presumptions', () => recomputePresumptions())
  if (outcome.skipped) return NextResponse.json({ error: 'Đang tính lại giả định' }, { status: 409 })
  return NextResponse.json(outcome.result)
}
