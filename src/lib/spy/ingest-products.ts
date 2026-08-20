import { prisma } from '@/lib/db'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'

export async function ingestStoreProducts(
  storeId: string, scanId: string, products: ParsedSpyProduct[],
): Promise<{ found: number; created: number; updated: number }> {
  let created = 0, updated = 0
  const now = new Date()
  for (const p of products) {
    const existing = await prisma.spyProduct.findUnique({
      where: { storeId_externalProductId: { storeId, externalProductId: p.externalProductId } },
      select: { id: true, priceMin: true, priceMax: true, title: true },
    })
    const data = {
      handle: p.handle, title: p.title, productType: p.productType, vendor: p.vendor,
      tags: JSON.stringify(p.tags), imageUrl: p.imageUrl, priceMin: p.priceMin, priceMax: p.priceMax,
      variantCount: p.variantCount, availableVariantCount: p.availableVariantCount,
      publishedAt: p.publishedAt, dateSource: p.dateSource, status: 'active',
    }
    const row = await prisma.spyProduct.upsert({
      where: { storeId_externalProductId: { storeId, externalProductId: p.externalProductId } },
      create: { storeId, externalProductId: p.externalProductId, firstSeenAt: now, lastSeenAt: now, ...data },
      update: { lastSeenAt: now, ...data },
    })
    if (existing) {
      updated++
      const changed = existing.priceMin !== p.priceMin || existing.priceMax !== p.priceMax || existing.title !== p.title
      if (changed) {
        await prisma.spyProductSnapshot.create({
          data: { productId: row.id, scanId, title: p.title, priceMin: p.priceMin, priceMax: p.priceMax, available: p.availableVariantCount > 0 },
        })
      }
    } else {
      created++
    }
  }
  return { found: products.length, created, updated }
}
