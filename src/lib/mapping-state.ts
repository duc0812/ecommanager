import { prisma } from '@/lib/db'
import { loadTemplateContext, pickTemplate, type TemplateLookupLine } from '@/lib/print-template-resolve'

/**
 * Whether a design task can be worked on now, by its line's supplier set-up:
 * READY = a supplier and its print template; UNMAPPED = no supplier yet, but lines of the same product type have gone to
 * a supplier SKU that has a template (someone only has to map it); NO_TEMPLATE = the supplier SKU has no template, or no
 * line of this type ever reached a templated SKU (a supplier or a template has to be found first).
 */
export type MappingState = 'READY' | 'UNMAPPED' | 'NO_TEMPLATE'

export type MappingStateLine = TemplateLookupLine & { key: string; storeId: string; shopifyProductType: string | null }

export type MappingVerdict = { state: MappingState; hint: string | null }

export function typeKeyOf(productType: string | null | undefined): string {
  return (productType ?? '').trim().toLowerCase()
}

export function classifyMapping(line: { resolvedSupplierId: string | null; hasTemplate: boolean; typeHint: string | null }): MappingVerdict {
  if (line.resolvedSupplierId) return { state: line.hasTemplate ? 'READY' : 'NO_TEMPLATE', hint: null }
  return line.typeHint ? { state: 'UNMAPPED', hint: line.typeHint } : { state: 'NO_TEMPLATE', hint: null }
}

/** For each product type, the supplier product its lines went to most often among SKUs that have a print template. */
export async function templatedSupplierByType(typeKeys: string[]): Promise<Map<string, string>> {
  const wanted = Array.from(new Set(typeKeys.filter(Boolean)))
  if (wanted.length === 0) return new Map()
  const rows = await prisma.orderLine.groupBy({
    by: ['shopifyProductType', 'resolvedSupplierId', 'resolvedSupplierSku'],
    where: { resolvedSupplierId: { not: null }, resolvedSupplierSku: { not: null }, shopifyProductType: { not: null } },
    _count: { _all: true },
  })
  const relevant = rows.filter(r => wanted.includes(typeKeyOf(r.shopifyProductType)))
  if (relevant.length === 0) return new Map()
  const products = await prisma.supplierProduct.findMany({
    where: {
      printTemplateId: { not: null }, supplier: { isActive: true },
      OR: relevant.map(r => ({ supplierId: r.resolvedSupplierId as string, sku: r.resolvedSupplierSku as string })),
    },
    select: { supplierId: true, sku: true, productName: true, supplier: { select: { name: true } } },
  })
  const label = new Map(products.map(p => [`${p.supplierId}\u0000${p.sku}`, `${p.supplier.name} · ${p.productName?.trim() || p.sku}`]))
  const tally = new Map<string, Map<string, number>>()
  for (const r of relevant) {
    const name = label.get(`${r.resolvedSupplierId}\u0000${r.resolvedSupplierSku}`)
    if (!name) continue
    const type = typeKeyOf(r.shopifyProductType)
    const counts = tally.get(type) ?? new Map<string, number>()
    counts.set(name, (counts.get(name) ?? 0) + r._count._all)
    tally.set(type, counts)
  }
  const out = new Map<string, string>()
  tally.forEach((counts, type) => {
    const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]
    if (best) out.set(type, best[0])
  })
  return out
}

export async function mappingStates(lines: MappingStateLine[]): Promise<Map<string, MappingVerdict>> {
  const out = new Map<string, MappingVerdict>()
  if (lines.length === 0) return out
  const mapped = lines.filter(l => l.resolvedSupplierId)
  const productKeys = Array.from(new Set(mapped.filter(l => l.shopifyProductId).map(l => `${l.storeId}\u0000${l.shopifyProductId}`)))
  const profiles = productKeys.length
    ? await prisma.productProfile.findMany({
      where: { OR: productKeys.map(k => { const [storeId, shopifyProductId] = k.split('\u0000'); return { storeId, shopifyProductId } }) },
      select: { storeId: true, shopifyProductId: true, printTemplateId: true },
    })
    : []
  const profileOf = new Map(profiles.map(p => [`${p.storeId}\u0000${p.shopifyProductId}`, { printTemplateId: p.printTemplateId }]))
  const profileFor = (l: MappingStateLine) => (l.shopifyProductId ? profileOf.get(`${l.storeId}\u0000${l.shopifyProductId}`) ?? null : null)
  const ctx = await loadTemplateContext(mapped, mapped.map(l => profileFor(l)?.printTemplateId))
  const hints = await templatedSupplierByType(lines.filter(l => !l.resolvedSupplierId).map(l => typeKeyOf(l.shopifyProductType)))
  for (const l of lines) {
    const hasTemplate = !!l.resolvedSupplierId && !!pickTemplate(l, profileFor(l), ctx)
    out.set(l.key, classifyMapping({ resolvedSupplierId: l.resolvedSupplierId, hasTemplate, typeHint: hints.get(typeKeyOf(l.shopifyProductType)) ?? null }))
  }
  return out
}
