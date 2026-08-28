import { prisma } from '@/lib/db'
import { designKey, type DesignImportRow } from '@/lib/design-library'

export type DesignLibraryFilter = { supplierId?: string; sku?: string; ready?: boolean; source?: string }

export async function listDesignEntries(filter: DesignLibraryFilter) {
  const where: any = {}
  if (filter.supplierId) where.supplierId = filter.supplierId
  if (filter.sku) where.sku = { contains: filter.sku }
  if (typeof filter.ready === 'boolean') where.ready = filter.ready
  if (filter.source) where.source = filter.source
  return prisma.skuSupplierDesign.findMany({
    where,
    orderBy: [{ sku: 'asc' }, { supplierId: 'asc' }],
    include: { supplier: { select: { id: true, name: true, code: true } } },
  })
}

export async function upsertDesignEntry(input: {
  sku: string; supplierId: string; designLink?: string | null;
  ready?: boolean; note?: string | null; source?: string; trelloCardId?: string | null
}) {
  const ready = input.ready ?? (input.designLink ? true : false)
  return prisma.skuSupplierDesign.upsert({
    where: { sku_supplierId: { sku: input.sku, supplierId: input.supplierId } },
    create: {
      sku: input.sku, supplierId: input.supplierId,
      designLink: input.designLink ?? null, ready,
      note: input.note ?? null, source: input.source ?? 'MANUAL',
      trelloCardId: input.trelloCardId ?? null,
    },
    update: {
      ...(input.designLink !== undefined ? { designLink: input.designLink } : {}),
      ...(input.ready !== undefined ? { ready: input.ready } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.trelloCardId !== undefined ? { trelloCardId: input.trelloCardId } : {}),
    },
  })
}

export async function deleteDesignEntry(id: string) {
  await prisma.skuSupplierDesign.delete({ where: { id } })
}

export async function loadReadyDesignLookup(): Promise<Map<string, string | null>> {
  const rows = await prisma.skuSupplierDesign.findMany({
    where: { ready: true },
    select: { sku: true, supplierId: true, designLink: true },
  })
  return new Map(rows.map(r => [designKey(r.sku, r.supplierId), r.designLink]))
}

export async function loadMasterArtworkBySku(): Promise<Map<string, string | null>> {
  const rows = await prisma.skuDesign.findMany({ select: { sku: true, driveLink: true } })
  return new Map(rows.map(r => [r.sku, r.driveLink]))
}

export async function importDesignEntries(rows: DesignImportRow[]): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = []
  let upserted = 0
  const suppliers = await prisma.supplier.findMany({ select: { id: true, code: true } })
  const supplierIdByCode = new Map(suppliers.map(s => [s.code, s.id]))
  for (const row of rows) {
    const supplierId = supplierIdByCode.get(row.supplierCode)
    if (!supplierId) { errors.push(`Unknown supplierCode: ${row.supplierCode} (sku ${row.sku})`); continue }
    await upsertDesignEntry({ sku: row.sku, supplierId, designLink: row.designLink, ready: true, source: 'MANUAL' })
    upserted += 1
  }
  return { upserted, errors }
}

export async function markLibraryReadyByCard(cardId: string, designLink: string): Promise<number> {
  const res = await prisma.skuSupplierDesign.updateMany({
    where: { trelloCardId: cardId, ready: false },
    data: { ready: true, designLink },
  })
  return res.count
}
