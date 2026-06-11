import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const [suppliers, products] = await Promise.all([
    prisma.supplier.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    }),
    prisma.supplierProduct.findMany({
      orderBy: [{ supplier: { name: 'asc' } }, { productName: 'asc' }],
      include: { supplier: { select: { id: true, name: true, code: true } } },
    }),
  ])
  return NextResponse.json({ suppliers, products })
}
