import { prisma } from '@/lib/db'
import { fetchStoreProducts } from './scan-products'
import { ingestStoreProducts } from './ingest-products'

export async function runStoreProductScan(store: { id: string; domain: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'STORE_PRODUCTS', targetType: 'STORE', targetId: store.id, status: 'running' },
  })
  try {
    const { products, totalScanned } = await fetchStoreProducts(store.domain)
    const ingest = await ingestStoreProducts(store.id, scan.id, products)
    const stats = { totalScanned, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
