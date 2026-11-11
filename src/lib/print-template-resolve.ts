import { isTopperProductType, topperPrintCutTemplate } from '@/lib/print-cut'
import { prisma } from '@/lib/db'
import { partKey } from '@/lib/task-files'

/** `shaped`: the template's guide draws this piece's real outline, so the canvas shows no box around it and names it above. */
export type TemplateArea = { name: string; x: number; y: number; w: number; h: number; shaped?: boolean; sizing?: 'MATCH_PRINT_CUT' }
/** A part set a line may deliver instead of the template's own areas (Mango WZIP: 12 piece files instead of the one sheet). */
export type TemplateAreaSet = { label: string; widthPx: number; heightPx: number; areas: TemplateArea[]; filesUntil?: string }

export type TemplateRow = {
  id: string; name: string; widthPx: number; heightPx: number; dpi: number; bleedIn: number; safeIn: number; mirror: boolean
  areas: TemplateArea[]; guideImageUrl: string | null; templateUrl: string | null
  altSets: TemplateAreaSet[]
  /** The alternative set this view shows (`areas` are its areas), null for the template's own areas. */
  areaSet: string | null
}

export type TemplateLookupLine = { orderId: string; resolvedSupplierId: string | null; resolvedSupplierSku: string | null; shopifyProductId?: string | null; shopifyProductType?: string | null }

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
      .map((s: any) => ({ label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `${s.areas.length} mảnh`, widthPx: Number(s.widthPx) || 0, heightPx: Number(s.heightPx) || 0, areas: s.areas as TemplateArea[], ...(typeof s.filesUntil === 'string' ? { filesUntil: s.filesUntil } : {}) }))
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

/**
 * Which part set a line is filling: the template's own areas (index -1) or one of its alternative sets — the one with the
 * most parts already uploaded. A tie keeps the earlier choice, so an empty line starts on the template's own areas.
 */
export function chooseAreaSet(template: Pick<TemplateRow, 'areas' | 'altSets'>, partsPresent: string[]): number {
  const have = new Set(partsPresent.map(partKey))
  const count = (areas: TemplateArea[]) => areas.filter(a => have.has(partKey(a.name))).length
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
export type TemplateContext = { byId: Map<string, TemplateRecord>; productTemplate: Map<string, TemplateRecord>; bySupplier: Map<string, TemplateRecord[]>; supplierCodes?: Map<string, string> }

const pairKey = (supplierId: string, sku: string) => `${supplierId}\u0000${sku}`

export async function loadTemplateContext(lines: TemplateLookupLine[], profileTemplateIds: Array<string | null | undefined>): Promise<TemplateContext> {
  const ids = Array.from(new Set(profileTemplateIds.filter((x): x is string => !!x)))
  const supplierIds = Array.from(new Set(lines.map(l => l.resolvedSupplierId).filter((x): x is string => !!x)))
  const skus = Array.from(new Set(lines.filter(l => l.resolvedSupplierId && l.resolvedSupplierSku).map(l => l.resolvedSupplierSku as string)))
  const topperSupplierIds = Array.from(new Set(lines.filter(l => isTopperProductType(l.shopifyProductType)).map(l => l.resolvedSupplierId).filter((id): id is string => !!id)))
  const [profileTemplates, products, supplierTemplates, topperSuppliers] = await Promise.all([
    ids.length ? prisma.printTemplate.findMany({ where: { id: { in: ids } } }) : [],
    supplierIds.length && skus.length
      ? prisma.supplierProduct.findMany({ where: { supplierId: { in: supplierIds }, sku: { in: skus }, printTemplateId: { not: null } }, select: { supplierId: true, sku: true, printTemplate: true } })
      : [],
    supplierIds.length ? prisma.printTemplate.findMany({ where: { supplierId: { in: supplierIds } } }) : [],
    topperSupplierIds.length ? prisma.supplier.findMany({ where: { id: { in: topperSupplierIds } }, select: { id: true, code: true } }) : [],
  ])
  const byId = new Map<string, TemplateRecord>(profileTemplates.map(t => [t.id, t]))
  const productTemplate = new Map<string, TemplateRecord>()
  for (const p of products) if (p.printTemplate) productTemplate.set(pairKey(p.supplierId, p.sku), p.printTemplate)
  const bySupplier = new Map<string, TemplateRecord[]>()
  for (const t of supplierTemplates) bySupplier.set(t.supplierId, [...(bySupplier.get(t.supplierId) ?? []), t])
  return { byId, productTemplate, bySupplier, supplierCodes: new Map(topperSuppliers.map(s => [s.id, s.code])) }
}

/** A pin ending in -S/-M/-L/-XL names one size of a set: a line of another size takes the set's template of its own size (owner 11-03: TN2407261608 on C932-PGWB2-*; TN2407261539, whose blank SKUs read M--114-INCHES, on LBW-PG-*). */
function sizedSibling(pinned: TemplateRecord, line: TemplateLookupLine, ctx: TemplateContext): TemplateRecord {
  const pin = pinned.supplierSku?.match(/^(.+)-(?:XL|[SML])$/i)
  const size = line.resolvedSupplierSku?.match(/-([SML])$/i) ?? line.resolvedSupplierSku?.match(/^(XL|[SML])--/i)
  if (!pin || !size) return pinned
  const want = `${pin[1]}-${size[1]}`.toLowerCase()
  return ctx.bySupplier.get(pinned.supplierId)?.find(t => t.supplierSku?.toLowerCase() === want) ?? pinned
}

export const GUIDE_SIZE_TOKEN = '{SIZE}'
export const GUIDE_SIZE = /^(XS|S|M|L|XL|[2-6]XL)$/

/** A guide path holding {SIZE} has one image per size on one template row (owner 11-04: TBEJ), so the library entries on that row keep working. */
export function pickTemplate(line: TemplateLookupLine, profile: { printTemplateId: string | null } | null, ctx: TemplateContext): TemplateRow | null {
  const picked = pickTemplateRecord(line, profile, ctx)
  if (!picked) return topperPrintCutTemplate(line.shopifyProductType, line.resolvedSupplierId ? ctx.supplierCodes?.get(line.resolvedSupplierId) ?? null : undefined)
  const row = mapTemplate(picked)
  const size = line.resolvedSupplierSku?.match(/-([0-9A-Z]+)$/i)?.[1].toUpperCase()
  if (row.guideImageUrl && picked.guideImagePath?.includes(GUIDE_SIZE_TOKEN) && size && GUIDE_SIZE.test(size)) {
    row.guideImageUrl += `${row.guideImageUrl.includes('?') ? '&' : '?'}size=${size}`
  }
  return row
}

function pickTemplateRecord(line: TemplateLookupLine, profile: { printTemplateId: string | null } | null, ctx: TemplateContext): TemplateRecord | null {
  if (profile?.printTemplateId) {
    const fromProfile = ctx.byId.get(profile.printTemplateId)
    if (fromProfile && (!line.resolvedSupplierId || fromProfile.supplierId === line.resolvedSupplierId)) return sizedSibling(fromProfile, line, ctx)
  }
  if (!line.resolvedSupplierId) return null
  if (line.resolvedSupplierSku) {
    const fromProduct = ctx.productTemplate.get(pairKey(line.resolvedSupplierId, line.resolvedSupplierSku))
    if (fromProduct && fromProduct.supplierId === line.resolvedSupplierId) return fromProduct
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
  return picked
}
