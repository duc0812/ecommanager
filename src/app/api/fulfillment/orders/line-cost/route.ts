import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body.lineId !== 'string') {
    return NextResponse.json({ error: 'lineId required' }, { status: 400 })
  }
  const value = body.manualBaseCost
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return NextResponse.json({ error: 'manualBaseCost must be a number >= 0 or null' }, { status: 400 })
  }

  const line = await prisma.orderLine.findUnique({
    where: { id: body.lineId },
    select: { id: true, resolvedSupplierId: true },
  })
  if (!line) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
  if (value !== null && !line.resolvedSupplierId) {
    return NextResponse.json({ error: 'Line chưa được map supplier — map trước khi nhập giá manual' }, { status: 400 })
  }

  const updated = await prisma.orderLine.update({
    where: { id: line.id },
    data: { manualBaseCost: value },
  })
  return NextResponse.json({ line: updated })
}
