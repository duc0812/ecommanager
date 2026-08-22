import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { groupByNiche } from '@/lib/spy/signals'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'
import { domainVariants } from '@/lib/spy/domain-filter'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const storeId = searchParams.get('storeId') || undefined
  const domain = searchParams.get('domain') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const productTypeId = searchParams.get('productTypeId') || undefined
  const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10), 90)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const and: any[] = [{ firstSeenAt: { gte: since } }]
  if (storeId) and.push({ storeId })
  if (domain) and.push({ store: { domain: { in: domainVariants(domain) } } })
  if (nicheId) {
    const n = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(n?.keywords), ['title'])
    if (nw) and.push(nw)
  }
  if (productTypeId) {
    const pt = await prisma.spyProductType.findUnique({ where: { id: productTypeId }, select: { keywords: true } })
    const pw = nicheOrWhere(parseKeywords(pt?.keywords), ['title'])
    if (pw) and.push(pw)
  }
  const where: any = { AND: and }

  const products = await prisma.spyProduct.findMany({
    where,
    orderBy: { firstSeenAt: 'desc' },
    take: limit,
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json({ products, niches: groupByNiche(products) })
}
