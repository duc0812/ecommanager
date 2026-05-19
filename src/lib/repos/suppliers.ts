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
        requiresDesign: p.requiresDesign,
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

export type ProductFilter = {
  supplierId?: string
  search?: string
  limit?: number
  offset?: number
}

export async function listProducts(f: ProductFilter = {}) {
  const where: any = {}
  if (f.supplierId) where.supplierId = f.supplierId
  if (f.search) {
    where.OR = [
      { sku: { contains: f.search } },
      { productName: { contains: f.search } },
    ]
  }
  return prisma.supplierProduct.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: f.limit ?? 200,
    skip: f.offset ?? 0,
    include: { supplier: { select: { id: true, name: true, code: true, currency: true } } },
  })
}

export async function countProducts(f: ProductFilter = {}) {
  const where: any = {}
  if (f.supplierId) where.supplierId = f.supplierId
  if (f.search) {
    where.OR = [
      { sku: { contains: f.search } },
      { productName: { contains: f.search } },
    ]
  }
  return prisma.supplierProduct.count({ where })
}

export type ProductUpsertInput = {
  supplierId: string
  sku: string
  baseCost: number
  productName?: string | null
  currency?: string
}

export async function upsertProductMapping(input: ProductUpsertInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.supplierProduct.findUnique({
      where: { supplierId_sku: { supplierId: input.supplierId, sku: input.sku } },
    })
    const product = await tx.supplierProduct.upsert({
      where: { supplierId_sku: { supplierId: input.supplierId, sku: input.sku } },
      create: {
        supplierId: input.supplierId,
        sku: input.sku,
        baseCost: input.baseCost,
        productName: input.productName ?? null,
        currency: input.currency ?? 'USD',
      },
      update: {
        baseCost: input.baseCost,
        productName: input.productName ?? null,
        currency: input.currency ?? 'USD',
      },
    })
    if (existing && existing.baseCost !== input.baseCost) {
      await tx.supplierCostHistory.create({
        data: {
          supplierId: input.supplierId,
          sku: input.sku,
          oldCost: existing.baseCost,
          newCost: input.baseCost,
        },
      })
    }
    return product
  })
}

export type BulkUpsertResult = {
  created: number
  updated: number
  errors: Array<{ row: number; sku: string; error: string }>
}

export async function bulkUpsertProducts(
  supplierId: string,
  rows: Array<{ sku: string; baseCost: number; productName?: string | null; currency?: string }>,
): Promise<BulkUpsertResult> {
  const result: BulkUpsertResult = { created: 0, updated: 0, errors: [] }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r.sku) { result.errors.push({ row: i, sku: '', error: 'sku is required' }); continue }
    if (!Number.isFinite(r.baseCost)) { result.errors.push({ row: i, sku: r.sku, error: 'baseCost must be a number' }); continue }
    try {
      const before = await prisma.supplierProduct.findUnique({
        where: { supplierId_sku: { supplierId, sku: r.sku } },
      })
      await upsertProductMapping({ supplierId, ...r })
      if (before) result.updated++; else result.created++
    } catch (e: any) {
      result.errors.push({ row: i, sku: r.sku, error: e.message })
    }
  }
  return result
}

export async function deleteProductMapping(id: string) {
  return prisma.supplierProduct.delete({ where: { id } })
}
