import { NextRequest, NextResponse } from 'next/server'
import { getPendingMappingQueue, listVariantManualMappings, saveManualMapping } from '@/lib/repos/mapping'

export async function GET() {
  const [pending, saved] = await Promise.all([
    getPendingMappingQueue(),
    listVariantManualMappings(),
  ])
  return NextResponse.json({ pending, saved })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.shopifyVariantId || !body.shopifyProductTitle || !body.supplierProductId) {
    return NextResponse.json({ error: 'shopifyVariantId, shopifyProductTitle, supplierProductId required' }, { status: 400 })
  }
  const mapping = await saveManualMapping({
    shopifyVariantId: body.shopifyVariantId,
    shopifyProductTitle: body.shopifyProductTitle,
    variantTitle: body.variantTitle ?? null,
    supplierProductId: body.supplierProductId,
    productBaseId: body.productBaseId ?? null,
    notes: body.notes ?? null,
  })
  return NextResponse.json({ mapping }, { status: 201 })
}
