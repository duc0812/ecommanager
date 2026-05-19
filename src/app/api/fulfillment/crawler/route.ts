import { NextRequest, NextResponse } from 'next/server'
import { buildSupplierProductCandidates } from '@/lib/repos/suppliers'
import {
  buildShopifyProductCsv,
  fetchPublicShopifyProduct,
  mapCrawledVariants,
} from '@/lib/shopify-crawler'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.url) {
    return NextResponse.json({ error: 'url required' }, { status: 400 })
  }

  try {
    const product = await fetchPublicShopifyProduct(body.url)
    const candidates = await buildSupplierProductCandidates()
    const mappings = mapCrawledVariants(product, candidates, body.skuPrefix || undefined)
    const status = ['draft', 'active', 'archived'].includes(body.status) ? body.status : 'draft'
    const csv = buildShopifyProductCsv(product, mappings, status)
    const unmappedCount = mappings.filter(m => !m.supplierSku).length

    return NextResponse.json({
      product: {
        id: product.id,
        title: product.title,
        handle: product.handle,
        vendor: product.vendor ?? '',
        productType: product.product_type ?? '',
        tags: product.tags ?? [],
        image: product.images?.[0]?.src ?? null,
        variantCount: product.variants?.length ?? 0,
        imageCount: product.images?.length ?? 0,
      },
      mappings,
      unmappedCount,
      csv,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Crawler failed' }, { status: 500 })
  }
}
