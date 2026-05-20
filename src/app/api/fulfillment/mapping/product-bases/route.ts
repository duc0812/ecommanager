import { NextRequest, NextResponse } from 'next/server'
import { listProductBases, createProductBase } from '@/lib/repos/mapping'

export async function GET() {
  const bases = await listProductBases()
  return NextResponse.json({ bases })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name || !body.shopifyProductType || !body.variantConditions) {
    return NextResponse.json({ error: 'name, shopifyProductType, variantConditions required' }, { status: 400 })
  }
  const base = await createProductBase({
    name: body.name,
    shopifyProductType: body.shopifyProductType,
    variantConditions: body.variantConditions,
    notes: body.notes ?? null,
    supplierMappings: body.supplierMappings ?? [],
    overrides: body.overrides ?? [],
  })
  return NextResponse.json({ base }, { status: 201 })
}
