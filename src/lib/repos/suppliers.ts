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

export type CreateSupplierInput = {
  name: string
  code: string
  apiType?: string | null
  apiKey?: string | null
  firstItemShipFee?: number
  additionalItemShipFee?: number
  currency?: string
  preferenceRank?: number
  note?: string | null
}

export async function listAllSuppliers(opts: { includeInactive?: boolean } = {}) {
  return prisma.supplier.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: { name: 'asc' },
    include: {
      _count: { select: { products: true, templates: true } },
    },
  })
}

export async function createSupplier(input: CreateSupplierInput) {
  return prisma.supplier.create({
    data: {
      name: input.name,
      code: input.code,
      apiType: input.apiType ?? null,
      apiKey: input.apiKey ?? null,
      firstItemShipFee: input.firstItemShipFee ?? 0,
      additionalItemShipFee: input.additionalItemShipFee ?? 0,
      currency: input.currency ?? 'USD',
      preferenceRank: input.preferenceRank ?? 0,
      note: input.note ?? null,
    },
  })
}

export type UpdateSupplierInput = Partial<CreateSupplierInput> & { isActive?: boolean }

export async function updateSupplier(id: string, input: UpdateSupplierInput) {
  return prisma.supplier.update({
    where: { id },
    data: input,
  })
}

export async function deactivateSupplier(id: string) {
  return prisma.supplier.update({ where: { id }, data: { isActive: false } })
}
