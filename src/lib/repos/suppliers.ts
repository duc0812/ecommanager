import { prisma } from '@/lib/db'
import type { SupplierInput } from '@/lib/pl-calculator'

export async function listActiveSuppliers() {
  return prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } })
}

export async function getSupplierById(id: string) {
  return prisma.supplier.findUnique({ where: { id } })
}

/**
 * Build global SKU -> SupplierInput map for P/L calculation.
 * If 2+ suppliers map same SKU, pick the one with highest preferenceRank.
 * Shared across all projects (suppliers are global).
 */
export async function buildSkuPriceMap(): Promise<Record<string, SupplierInput>> {
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true } })
  const products = await prisma.supplierProduct.findMany()
  const byId = new Map(suppliers.map(s => [s.id, s]))
  const map: Record<string, SupplierInput> = {}
  for (const p of products) {
    const sup = byId.get(p.supplierId)
    if (!sup) continue
    const existing = map[p.sku]
    const existingRank = existing ? (byId.get(existing.supplierId)?.preferenceRank ?? 0) : -Infinity
    if (!existing || sup.preferenceRank > existingRank) {
      map[p.sku] = {
        supplierId: sup.id,
        baseCost: p.baseCost,
        firstItemShipFee: sup.firstItemShipFee,
        additionalItemShipFee: sup.additionalItemShipFee,
      }
    }
  }
  return map
}
