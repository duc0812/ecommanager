import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { domainVariants } from '@/lib/spy/domain-filter'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'
import { rankDelta } from '@/lib/spy/best-seller'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '12', 10) || 12, 100)

  const stores = domain
    ? await prisma.spyStore.findMany({ where: { domain: { in: domainVariants(domain) } }, select: { id: true, domain: true } })
    : await prisma.spyStore.findMany({ where: { status: 'active' }, select: { id: true, domain: true }, orderBy: { domain: 'asc' } })

  const prodAnd: any[] = []
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title'])
    if (nw) prodAnd.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title'])
    if (pw) prodAnd.push(pw)
  }
  const productWhere = prodAnd.length ? { AND: prodAnd } : undefined

  const groups: any[] = []
  for (const s of stores) {
    const scan = await prisma.spyScan.findFirst({
      where: { type: 'STORE_BESTSELLER', targetId: s.id, status: 'success' },
      orderBy: { startedAt: 'desc' }, select: { id: true },
    })
    if (!scan) continue
    const rows = await prisma.spyBestSeller.findMany({
      where: { scanId: scan.id, ...(productWhere ? { product: productWhere } : {}) },
      orderBy: { rank: 'asc' }, take: limit,
      include: { product: { include: { store: { select: { domain: true } } } } },
    })
    if (rows.length === 0) continue
    const items = rows.map(r => ({ ...r.product, rank: r.rank, prevRank: r.prevRank, delta: rankDelta(r.rank, r.prevRank) }))
    groups.push({ store: { domain: s.domain }, items })
  }
  return NextResponse.json({ groups })
}
