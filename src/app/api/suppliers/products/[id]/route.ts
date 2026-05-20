import { NextRequest, NextResponse } from 'next/server'
import { deleteProductMapping, upsertProductMapping } from '@/lib/repos/suppliers'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const existing = await prisma.supplierProduct.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: 'At least one field required' }, { status: 400 })
  }
  const updated = await upsertProductMapping({
    supplierId: existing.supplierId,
    sku: existing.sku,
    baseCost: body.baseCost != null ? Number(body.baseCost) : existing.baseCost,
    productName: body.productName !== undefined ? body.productName : existing.productName,
    currency: body.currency ?? existing.currency,
    requiresDesign: body.requiresDesign !== undefined ? Boolean(body.requiresDesign) : existing.requiresDesign,
    baseSku: body.baseSku !== undefined ? body.baseSku : existing.baseSku,
    productType: body.productType !== undefined ? body.productType : existing.productType,
    variant1Name: body.variant1Name !== undefined ? body.variant1Name : existing.variant1Name,
    variant1Value: body.variant1Value !== undefined ? body.variant1Value : existing.variant1Value,
    variant2Name: body.variant2Name !== undefined ? body.variant2Name : existing.variant2Name,
    variant2Value: body.variant2Value !== undefined ? body.variant2Value : existing.variant2Value,
    designTemplateUrl: body.designTemplateUrl !== undefined ? body.designTemplateUrl : existing.designTemplateUrl,
    minProductionDays: body.minProductionDays !== undefined ? body.minProductionDays : existing.minProductionDays,
    maxProductionDays: body.maxProductionDays !== undefined ? body.maxProductionDays : existing.maxProductionDays,
    shippingByRegion: body.shippingByRegion !== undefined ? body.shippingByRegion : existing.shippingByRegion,
    textureOfMaterial: body.textureOfMaterial !== undefined ? body.textureOfMaterial : existing.textureOfMaterial,
  })
  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await deleteProductMapping(params.id)
  return NextResponse.json({ ok: true })
}
