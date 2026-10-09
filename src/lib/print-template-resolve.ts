import { prisma } from '@/lib/db'

export type TemplateRow = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: { name: string; x: number; y: number; w: number; h: number }[]; guideImageUrl: string | null; templateUrl: string | null
}

export type TemplateLookupLine = { orderId: string; resolvedSupplierId: string | null; resolvedSupplierSku: string | null; shopifyProductId?: string | null }

function parseTemplateAreas(json: string): TemplateRow['areas'] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function mapTemplate(t: { id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean; areas: string; guideImagePath: string | null; templateUrl: string | null; updatedAt?: Date }): TemplateRow {
  const version = t.updatedAt ? `?v=${t.updatedAt.getTime()}` : ''
  return {
    id: t.id, name: t.name, widthPx: t.widthPx, heightPx: t.heightPx, dpi: t.dpi, bleedIn: t.bleedIn, safeIn: t.safeIn, mirror: t.mirror,
    areas: parseTemplateAreas(t.areas), guideImageUrl: t.guideImagePath ? `/api/design-studio/file/guide/${t.id}${version}` : null, templateUrl: t.templateUrl,
  }
}

type TemplateRecord = Parameters<typeof mapTemplate>[0] & { supplierId: string; supplierSku: string | null }
export type TemplateContext = { byId: Map<string, TemplateRecord>; productTemplate: Map<string, TemplateRecord>; bySupplier: Map<string, TemplateRecord[]> }

const pairKey = (supplierId: string, sku: string) => `${supplierId}\u0000${sku}`

export async function loadTemplateContext(lines: TemplateLookupLine[], profileTemplateIds: Array<string | null | undefined>): Promise<TemplateContext> {
  const ids = Array.from(new Set(profileTemplateIds.filter((x): x is string => !!x)))
  const supplierIds = Array.from(new Set(lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x)))
  const skus = Array.from(new Set(lines.filter(l => l.resolvedSupplierId && l.resolvedSupplierSku).map(l => l.resolvedSupplierSku as string)))
  const [profileTemplates, products, supplierTemplates] = await Promise.all([
    ids.length ? prisma.printTemplate.findMany({ where: { id: { in: ids } } }) : [],
    supplierIds.length && skus.length
      ? prisma.supplierProduct.findMany({ where: { supplierId: { in: supplierIds }, sku: { in: skus }, printTemplateId: { not: null } }, select: { supplierId: true, sku: true, printTemplate: true } })
      : [],
    supplierIds.length ? prisma.printTemplate.findMany({ where: { supplierId: { in: supplierIds } } }) : [],
  ])
  const byId = new Map<string, TemplateRecord>(profileTemplates.map(t => [t.id, t]))
  const productTemplate = new Map<string, TemplateRecord>()
  for (const p of products) if (p.printTemplate) productTemplate.set(pairKey(p.supplierId, p.sku), p.printTemplate)
  const bySupplier = new Map<string, TemplateRecord[]>()
  for (const t of supplierTemplates) bySupplier.set(t.supplierId, [...(bySupplier.get(t.supplierId) ?? []), t])
  return { byId, productTemplate, bySupplier }
}

export function pickTemplate(line: TemplateLookupLine, profile: { printTemplateId: string | null } | null, ctx: TemplateContext): TemplateRow | null {
  if (profile?.printTemplateId) {
    const fromProfile = ctx.byId.get(profile.printTemplateId)
    if (fromProfile && (!line.resolvedSupplierId || fromProfile.supplierId === line.resolvedSupplierId)) return mapTemplate(fromProfile)
  }
  if (!line.resolvedSupplierId) return null
  if (line.resolvedSupplierSku) {
    const fromProduct = ctx.productTemplate.get(pairKey(line.resolvedSupplierId, line.resolvedSupplierSku))
    if (fromProduct && fromProduct.supplierId === line.resolvedSupplierId) return mapTemplate(fromProduct)
  }
  const templates = ctx.bySupplier.get(line.resolvedSupplierId) ?? []
  if (templates.length === 0) return null

  const sku = line.resolvedSupplierSku ? line.resolvedSupplierSku.toLowerCase() : null
  let picked = sku ? templates.find(t => t.supplierSku !== null && t.supplierSku.toLowerCase() === sku) : undefined
  if (!picked && sku) {
    const prefixMatches = templates.filter(t => t.supplierSku !== null && sku.startsWith(t.supplierSku.toLowerCase()))
    prefixMatches.sort((a, b) => (b.supplierSku as string).length - (a.supplierSku as string).length)
    picked = prefixMatches[0]
  }
  if (!picked) picked = templates.find(t => t.supplierSku === null)
  if (!picked) return null
  return mapTemplate(picked)
}
