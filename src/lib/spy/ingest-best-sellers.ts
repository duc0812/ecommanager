import { prisma } from '@/lib/db'
import type { ParsedSpyProduct } from '@/lib/spy/shopify'
import { upsertStoreProduct } from '@/lib/spy/ingest-products'

export async function ingestStoreBestSellers(
  storeId: string, scanId: string, products: ParsedSpyProduct[],
): Promise<{ found: number }> {
  const now = new Date()
  for (let i = 0; i < products.length; i++) {
    const { id } = await upsertStoreProduct(storeId, scanId, products[i], now)
    const prev = await prisma.spyBestSeller.findFirst({
      where: { storeId, productId: id }, orderBy: { capturedAt: 'desc' }, select: { rank: true },
    })
    await prisma.spyBestSeller.create({
      data: { storeId, productId: id, scanId, rank: i + 1, prevRank: prev?.rank ?? null },
    })
  }
  return { found: products.length }
}
