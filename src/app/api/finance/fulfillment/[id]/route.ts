import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.fulfillmentCost.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const cost = await prisma.fulfillmentCost.update({
    where: { id: params.id },
    data: {
      paymentStatus: body.paymentStatus,
      paymentDate: body.paymentDate || null,
      paymentMethod: body.paymentMethod || null,
      referenceNumber: body.referenceNumber || null,
    },
  })
  return NextResponse.json({ ok: true, cost })
}
