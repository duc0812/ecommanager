import { NextRequest, NextResponse } from 'next/server'
import { deleteProductMapping, upsertProductMapping } from '@/lib/repos/suppliers'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const existing = await prisma.supplierProduct.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (body.baseCost == null && body.productName == null) {
    return NextResponse.json({ error: 'baseCost or productName required' }, { status: 400 })
  }
  const updated = await upsertProductMapping({
    supplierId: existing.supplierId,
    sku: existing.sku,
    baseCost: body.baseCost != null ? Number(body.baseCost) : existing.baseCost,
    productName: body.productName !== undefined ? body.productName : existing.productName,
    currency: body.currency ?? existing.currency,
  })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteProductMapping(params.id)
  return NextResponse.json({ ok: true })
}
