import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { groupByNiche } from '@/lib/spy/signals'
import { parseKeywords, nicheOrWhere } from '@/lib/spy/niche'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const storeId = searchParams.get('storeId') || undefined
  const nicheId = searchParams.get('nicheId') || undefined
  const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10), 90)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const base: any = { firstSeenAt: { gte: since }, ...(storeId ? { storeId } : {}) }
  let where: any = base
  if (nicheId) {
    const niche = await prisma.spyNiche.findUnique({ where: { id: nicheId }, select: { keywords: true } })
    const nw = nicheOrWhere(parseKeywords(niche?.keywords), ['title'])
    if (nw) where = { AND: [base, nw] }
  }
  const products = await prisma.spyProduct.findMany({
    where,
    orderBy: { firstSeenAt: 'desc' },
    take: limit,
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json({ products, niches: groupByNiche(products) })
}
