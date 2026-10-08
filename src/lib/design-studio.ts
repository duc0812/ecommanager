import { prisma } from '@/lib/db'
import { visibleCustomAttributes, customerDesignLink } from '@/lib/order-classify'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'
import { lineDesignStatus, type LineDesignStatus } from '@/lib/design-status'
import { loadReadyDesignEntries } from '@/lib/repos/design-library'
import { matchDesignEntry } from '@/lib/design-parent'

export type CustomAttribute = { key: string; value: string }
export type SourcePrintFile = { printArea: string; url: string }
export type ArtworkRow = {
  id: string; printArea: string; version: number; fileName: string; size: number
  mimeType: string; uploadedById: string | null; createdAt: string; url: string
}
export type WorkspaceLine = {
  id: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: CustomAttribute[]
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  sourcePrintFiles: SourcePrintFile[]
  supplier: { id: string; name: string; code: string } | null
  supplierSku: string | null
  templateUrl: string | null
  masterArtworkUrl: string | null
  libraryDesignLink: string | null
  designStatus: LineDesignStatus
  designDriveLink: string | null
  designNote: string | null
  printAreas: string[]
  artworks: ArtworkRow[]
}
export type Workspace = {
  order: {
    id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: string; orderType: string
    designReady: boolean; trelloCardUrl: string | null
    store: { shop: string; projectId: string; projectName: string }
  }
  lines: WorkspaceLine[]
}

export const DEFAULT_PRINT_AREA = 'Artwork'

export function parseAttributes(json: string | null): CustomAttribute[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is CustomAttribute =>
    !!a && typeof a === 'object' && typeof (a as any).key === 'string' && typeof (a as any).value === 'string')
}

export function sourcePrintFiles(attrs: CustomAttribute[]): SourcePrintFile[] {
  const pf = attrs.find(a => a.key === '_print_files')?.value
  if (pf) {
    try {
      const parsed = JSON.parse(pf)
      if (Array.isArray(parsed)) {
        const out = parsed
          .filter(p => p && typeof p.url === 'string')
          .map(p => ({ printArea: typeof p.print_area === 'string' && p.print_area.trim() ? p.print_area.trim() : 'Print', url: p.url as string }))
        if (out.length > 0) return out
      }
    } catch {}
  }
  const single = attrs.find(a => a.key === '_customall_print_file')?.value
  return single ? [{ printArea: 'Print', url: single }] : []
}

export function printAreasForLine(attrs: CustomAttribute[]): string[] {
  const pf = attrs.find(a => a.key === '_print_files')?.value
  if (!pf) return [DEFAULT_PRINT_AREA]
  let parsed: unknown
  try { parsed = JSON.parse(pf) } catch { return [DEFAULT_PRINT_AREA] }
  if (!Array.isArray(parsed)) return [DEFAULT_PRINT_AREA]
  const names = Array.from(new Set(
    parsed.map(p => (p && typeof p.print_area === 'string') ? p.print_area.trim() : '').filter(Boolean),
  ))
  return names.length > 0 ? names : [DEFAULT_PRINT_AREA]
}

export function artworkUrl(id: string): string {
  return `/api/design-studio/file/${id}`
}

function parseVariantOptions(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

export async function loadWorkspace(orderId: string): Promise<Workspace | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      store: { include: { project: { select: { id: true, name: true } } } },
      lines: {
        orderBy: { linePosition: 'asc' },
        include: { artworks: { orderBy: [{ printArea: 'asc' }, { version: 'desc' }] } },
      },
    },
  })
  if (!order) return null

  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const skus = Array.from(new Set(order.lines.map(l => l.sku).filter(Boolean) as string[]))
  const [suppliers, supplierProducts, skuDesigns, designEntries] = await Promise.all([
    supplierIds.length ? prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, code: true } }) : [],
    supplierIds.length
      ? prisma.supplierProduct.findMany({
          where: { supplierId: { in: supplierIds }, sku: { in: order.lines.map(l => l.resolvedSupplierSku).filter(Boolean) as string[] } },
          select: { supplierId: true, sku: true, designTemplateUrl: true },
        })
      : [],
    skus.length ? prisma.skuDesign.findMany({ where: { sku: { in: skus } }, select: { sku: true, driveLink: true } }) : [],
    loadReadyDesignEntries(),
  ])
  const supplierById = new Map(suppliers.map(s => [s.id, s]))
  const templateByKey = new Map(supplierProducts.map(p => [`${p.supplierId}::${p.sku}`, p.designTemplateUrl]))
  const masterBySku = new Map(skuDesigns.map(d => [d.sku, d.driveLink]))

  const lines: WorkspaceLine[] = order.lines.map(l => {
    const attrs = parseAttributes(l.customAttributesJson)
    const isNonProduct = isNonProductLine(l)
    const entry = matchDesignEntry(l.sku, l.resolvedSupplierId, designEntries)
    const preview = l.previewCdnUrl ?? extractPreviewCdnUrl(attrs)
    const productUrl = attrs.find(a => a.key === '_product_url')?.value ?? null
    return {
      id: l.id,
      linePosition: l.linePosition,
      sku: l.sku,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      qty: l.qty,
      isNonProduct,
      customized: l.customized,
      variantOptions: parseVariantOptions(l.variantOptions),
      attributesLoaded: l.customAttributesJson != null,
      personalization: visibleCustomAttributes(attrs).filter(a => a.value !== preview),
      customerDesignLink: customerDesignLink({ customAttributes: attrs, productUrl, variantId: l.shopifyVariantId }),
      customizedUrl: attrs.find(a => a.key === '_customized_url')?.value ?? null,
      previewUrl: preview,
      sourcePrintFiles: sourcePrintFiles(attrs),
      supplier: l.resolvedSupplierId ? (supplierById.get(l.resolvedSupplierId) ?? null) : null,
      supplierSku: l.resolvedSupplierSku,
      templateUrl: l.resolvedSupplierId && l.resolvedSupplierSku ? (templateByKey.get(`${l.resolvedSupplierId}::${l.resolvedSupplierSku}`) ?? null) : null,
      masterArtworkUrl: l.sku ? (masterBySku.get(l.sku) ?? null) : null,
      libraryDesignLink: entry?.designLink ?? null,
      designStatus: lineDesignStatus({
        isNonProduct, previewCdnUrl: l.previewCdnUrl, designDriveLink: l.designDriveLink,
        hasLibraryDesign: !!entry, customized: l.customized,
      }),
      designDriveLink: l.designDriveLink,
      designNote: l.designNote,
      printAreas: printAreasForLine(attrs),
      artworks: l.artworks.map(a => ({
        id: a.id, printArea: a.printArea, version: a.version, fileName: a.fileName, size: a.size,
        mimeType: a.mimeType, uploadedById: a.uploadedById, createdAt: a.createdAt.toISOString(), url: artworkUrl(a.id),
      })),
    }
  })

  return {
    order: {
      id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, placedAt: order.placedAt.toISOString(),
      pipelineStatus: order.pipelineStatus, orderType: order.orderType, designReady: order.designReady,
      trelloCardUrl: order.trelloCardUrl,
      store: { shop: order.store.shop, projectId: order.store.project!.id, projectName: order.store.project!.name },
    },
    lines,
  }
}
