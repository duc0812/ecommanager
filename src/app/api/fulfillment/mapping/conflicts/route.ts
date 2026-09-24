import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { findBaseOverlaps } from '@/lib/mapping-conflicts'

export const dynamic = 'force-dynamic'

// Which Product Bases of one product type can both match the same order line. The resolver has
// no way to choose between them, so the configuration has to keep them apart.
export async function GET() {
  const bases = await prisma.productBase.findMany({
    select: { id: true, name: true, shopifyProductType: true, variantConditions: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return NextResponse.json(
    { overlaps: findBaseOverlaps(bases) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
