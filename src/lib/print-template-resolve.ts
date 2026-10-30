import { prisma } from '@/lib/db'

export type TemplateArea = { name: string; x: number; y: number; w: number; h: number }
/** A part set a line may deliver instead of the template's own areas (Mango WZIP: 12 piece files instead of the one sheet). */
export type TemplateAreaSet = { label: string; widthPx: number; heightPx: number; areas: TemplateArea[] }

export type TemplateRow = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: TemplateArea[]; guideImageUrl: string | null; templateUrl: string | null
  altSets: TemplateAreaSet[]
  /** The alternative set this view shows (`areas` are its areas), null for the template's own areas. */
  areaSet: string | null
}

export type TemplateLookupLine = { orderId: string; resolvedSupplierId: string | null; resolvedSupplierSku: string | null; shopifyProductId?: string | null }

function parseTemplateAreas(json: string): TemplateRow['areas'] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

export function parseAltSets(json: string | null | undefined): TemplateAreaSet[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s: any) => s && typeof s === 'object' && Array.isArray(s.areas) && s.areas.length > 0)
      .map((s: any) => ({ label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `${s.areas.length} mảnh`, widthPx: Number(s.widthPx) || 0, heightPx: Number(s.heightPx) || 0, areas: s.areas as TemplateArea[] }))
  } catch { return [] }
}

export function mapTemplate(t: { id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean; areas: string; altAreas?: string | null; guideImagePath: string | null; templateUrl: string | null; updatedAt?: Date }): TemplateRow {
  const version = t.updatedAt ? `?v=${t.updatedAt.getTime()}` : ''
  return {
    id: t.id, name: t.name, widthPx: t.widthPx, heightPx: t.heightPx, dpi: t.dpi, bleedIn: t.bleedIn, safeIn: t.safeIn, mirror: t.mirror,
    areas: parseTemplateAreas(t.areas), guideImageUrl: t.guideImagePath ? `/api/design-studio/file/guide/${t.id}${version}` : null, templateUrl: t.templateUrl,
    altSets: parseAltSets(t.altAreas), areaSet: null,
  }
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Which part set a line is filling: the template's own areas (index -1) or one of its alternative sets — the one with the
 * most parts already uploaded. A tie keeps the earlier choice, so an empty line starts on the template's own areas.
 */
export function chooseAreaSet(template: Pick<TemplateRow, 'areas' | 'altSets'>, partsPresent: string[]): number {
  const have = new Set(partsPresent.map(norm))
  const count = (areas: TemplateArea[]) => areas.filter(a => have.has(norm(a.name))).length
  let best = -1, bestScore = count(template.areas)
  template.altSets.forEach((s, i) => {
    const score = count(s.areas)
    if (score > bestScore) { best = i; bestScore = score }
  })
  return best
}

/** Every part name a line of this template may upload: the template's areas and those of every alternative set. */
export function allSlotNames(template: Pick<TemplateRow, 'areas' | 'altSets'> | null): string[] {
  if (!template) return []
  return Array.from(new Set([...template.areas, ...template.altSets.flatMap(s => s.areas)].map(a => a.name).filter(Boolean)))
}

type PartLike = { kind?: string | null; printArea: string; removedAt?: Date | string | null }

/**
 * The template as the line sees it: its own areas, or — once the line's print files lean towards an alternative set —
 * that set's areas and canvas (the sheet guide does not fit a piece set, so it is dropped there).
 */
export function templateViewFor<T extends TemplateRow>(template: T | null, files: PartLike[]): T | null {
  if (!template || template.altSets.length === 0) return template
  const parts = files.filter(f => (f.kind ?? 'PRINT') === 'PRINT' && !f.removedAt).map(f => f.printArea)
  const i = chooseAreaSet(template, parts)
  if (i < 0) return template
  const set = template.altSets[i]
  return {
    ...template, areas: set.areas, areaSet: set.label,
    widthPx: set.widthPx > 0 ? set.widthPx : template.widthPx, heightPx: set.heightPx > 0 ? set.heightPx : template.heightPx,
    guideImageUrl: null,
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
