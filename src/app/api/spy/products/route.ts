import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { groupByNiche } from '@/lib/spy/signals'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const storeId = searchParams.get('storeId') || undefined
  const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10), 90)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const products = await prisma.spyProduct.findMany({
    where: { firstSeenAt: { gte: since }, ...(storeId ? { storeId } : {}) },
    orderBy: { firstSeenAt: 'desc' },
    take: limit,
    include: { store: { select: { domain: true } } },
  })
  return NextResponse.json({ products, niches: groupByNiche(products) })
}
