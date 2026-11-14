import { prisma } from '@/lib/db'

/** Shopify product ids the store sells as dropship (bought ready-made: no print file, only a supplier mapping). */
export async function dropshipProductIds(storeId: string): Promise<Set<string>> {
  const rows = await prisma.productProfile.findMany({ where: { storeId, dropship: true }, select: { shopifyProductId: true } })
  return new Set(rows.map(r => r.shopifyProductId))
}
