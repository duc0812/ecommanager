import { NextRequest, NextResponse } from 'next/server'
import { updateProductBase, deleteProductBase } from '@/lib/repos/mapping'
import { recalculateMissingOrderLineCosts } from '@/lib/repos/order-costs'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  if (!body.name || !body.shopifyProductType || !body.variantConditions) {
    return NextResponse.json({ error: 'name, shopifyProductType, variantConditions required' }, { status: 400 })
  }
  const base = await updateProductBase(params.id, {
    name: body.name,
    shopifyProductType: body.shopifyProductType,
    variantConditions: body.variantConditions,
    notes: body.notes ?? null,
    supplierMappings: body.supplierMappings ?? [],
    overrides: body.overrides ?? [],
  })
  const refresh = await recalculateMissingOrderLineCosts()
  return NextResponse.json({ base, refresh })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteProductBase(params.id)
  return NextResponse.json({ ok: true })
}
