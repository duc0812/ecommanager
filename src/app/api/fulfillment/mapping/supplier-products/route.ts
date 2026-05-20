import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const products = await prisma.supplierProduct.findMany({
    orderBy: [{ supplier: { name: 'asc' } }, { productName: 'asc' }],
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
  return NextResponse.json({ products })
}
