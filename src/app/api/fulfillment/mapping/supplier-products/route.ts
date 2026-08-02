import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [suppliers, products] = await Promise.all([
    prisma.supplier.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.supplierProduct.findMany({
      where: { supplier: { isActive: true } },
      orderBy: [{ supplier: { name: 'asc' } }, { productName: 'asc' }],
      include: { supplier: { select: { id: true, name: true, code: true } } },
    }),
  ])
  return NextResponse.json(
    { suppliers, products },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
