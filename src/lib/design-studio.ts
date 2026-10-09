import { prisma } from '@/lib/db'
import { visibleCustomAttributes, customerDesignLink } from '@/lib/order-classify'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'
import { lineDesignStatus, type LineDesignStatus } from '@/lib/design-status'
import { loadReadyDesignEntries } from '@/lib/repos/design-library'
import { matchDesignEntry } from '@/lib/design-parent'
import { autoDetectStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { fetchOrderLinePropsByNames, type ShopifyOrderLineProps } from '@/lib/shopify-orders'
import { getShopifyConnection } from '@/lib/token-store'

export type CustomAttribute = { key: string; value: string }
export type SourcePrintFile = { printArea: string; url: string }
export type ArtworkRow = {
  id: string; printArea: string; version: number; fileName: string; size: number
  mimeType: string; uploadedById: string | null; createdAt: string; url: string
  widthPx: number | null; heightPx: number | null
}
export type WorkspaceLine = {
  id: string; shopifyLineId: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: CustomAttribute[]
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  imageUrl: string | null
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

const DEFAULT_PRINT_AREA = 'Artwork'

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

export function safeHttpUrl(v: string | null | undefined): string | null {
  if (!v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : null
  } catch { return null }
}

function lastAttr(attrs: CustomAttribute[], key: string): string | null {
  for (let i = attrs.length - 1; i >= 0; i--) if (attrs[i].key === key) return attrs[i].value
  return null
}

function safeCustomerDesignLink(attrs: CustomAttribute[], productUrl: string | null, variantId: string | null): string | null {
  try { return safeHttpUrl(customerDesignLink({ customAttributes: attrs, productUrl, variantId })) } catch { return null }
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
      lines: { orderBy: { linePosition: 'asc' } },
      artworks: { orderBy: [{ printArea: 'asc' }, { version: 'desc' }] },
    },
  })
  if (!order) return null
  if (!order.store.project) return null

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
    const productUrl = safeHttpUrl(lastAttr(attrs, '_product_url'))
    const artworks = order.artworks.filter(a => a.shopifyLineId === l.shopifyLineId)
    return {
      id: l.id,
      shopifyLineId: l.shopifyLineId,
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
      customerDesignLink: safeCustomerDesignLink(attrs, productUrl, l.shopifyVariantId),
      customizedUrl: safeHttpUrl(attrs.find(a => a.key === '_customized_url')?.value),
      previewUrl: safeHttpUrl(preview),
      imageUrl: safeHttpUrl(l.imageUrl),
      sourcePrintFiles: sourcePrintFiles(attrs).flatMap(f => {
        const url = safeHttpUrl(f.url)
        return url ? [{ printArea: f.printArea, url }] : []
      }),
      supplier: l.resolvedSupplierId ? (supplierById.get(l.resolvedSupplierId) ?? null) : null,
      supplierSku: l.resolvedSupplierSku,
      templateUrl: l.resolvedSupplierId && l.resolvedSupplierSku ? safeHttpUrl(templateByKey.get(`${l.resolvedSupplierId}::${l.resolvedSupplierSku}`)) : null,
      masterArtworkUrl: l.sku ? safeHttpUrl(masterBySku.get(l.sku)) : null,
      libraryDesignLink: safeHttpUrl(entry?.designLink),
      designStatus: lineDesignStatus({
        isNonProduct, previewCdnUrl: l.previewCdnUrl, designDriveLink: l.designDriveLink,
        hasLibraryDesign: !!entry, customized: l.customized,
      }),
      designDriveLink: l.designDriveLink,
      designNote: l.designNote,
      printAreas: printAreasForLine(attrs),
      artworks: artworks.map(a => ({
        id: a.id, printArea: a.printArea, version: a.version, fileName: a.fileName, size: a.size,
        mimeType: a.mimeType, uploadedById: a.uploadedById, createdAt: a.createdAt.toISOString(), url: artworkUrl(a.id),
        widthPx: a.widthPx, heightPx: a.heightPx,
      })),
    }
  })

  return {
    order: {
      id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, placedAt: order.placedAt.toISOString(),
      pipelineStatus: order.pipelineStatus, orderType: order.orderType, designReady: order.designReady,
      trelloCardUrl: order.trelloCardUrl,
      store: { shop: order.store.shop, projectId: order.store.project.id, projectName: order.store.project.name },
    },
    lines,
  }
}

export async function updateLine(lineId: string, patch: { note?: string | null; done?: boolean; requiredAreas?: string[] }) {
  const line = await prisma.orderLine.findUnique({ where: { id: lineId } })
  if (!line) return null

  const data: { designNote?: string | null; designDriveLink?: string | null } = {}
  if (patch.note !== undefined) data.designNote = patch.note === null ? null : patch.note.trim() || null
  if (patch.done === true) {
    const artworks = await prisma.designArtwork.findMany({
      where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId },
      orderBy: { version: 'desc' },
    })
    const slots = patch.requiredAreas && patch.requiredAreas.length > 0
      ? patch.requiredAreas
      : printAreasForLine(parseAttributes(line.customAttributesJson))
    const missing = slots.filter(s => !artworks.some(a => a.printArea === s))
    if (missing.length > 0) throw new Error(`No artwork uploaded for: ${missing.join(', ')}`)
    const first = artworks.find(a => a.printArea === slots[0])!
    data.designDriveLink = artworkUrl(first.id)
  }
  if (patch.done === false) data.designDriveLink = null

  const updated = await prisma.orderLine.update({ where: { id: lineId }, data })
  const order = patch.done === undefined
    ? await prisma.order.findUniqueOrThrow({ where: { id: line.orderId }, select: { id: true, designReady: true, pipelineStatus: true } })
    : await recomputeOrderDesign(line.orderId, patch.done)
  return {
    line: { id: updated.id, designDriveLink: updated.designDriveLink, designNote: updated.designNote },
    order,
  }
}

async function recomputeOrderDesign(orderId: string, markedDone: boolean) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: { orderBy: { linePosition: 'asc' } } } })
  if (!order) throw new Error('order vanished')
  const productLines = order.lines.filter(l => !isNonProductLine(l))
  const designLines = productLines.filter(l => !!l.resolvedSupplierId)
  const designReady = designLines.length > 0 && designLines.every(l => !!l.designDriveLink)
  const currentStatus = (markedDone && designReady && order.pipelineStatus === 'DESIGN_REJECTED'
    ? 'PENDING_DESIGN'
    : order.pipelineStatus) as PipelineStatus
  const pipelineStatus = autoDetectStatus({
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    cancelled: order.pipelineStatus === 'CANCELLED',
    hasUnmappedSku: productLines.some(l => !l.resolvedSupplierId),
    hasPendingMapping: false,
    hasCustomDesignLine: designLines.length > 0,
    hasDesignLine: designLines.length > 0,
    hasDesignReady: designReady,
    currentStatus,
  })
  return prisma.order.update({
    where: { id: orderId },
    data: { designReady, pipelineStatus, designDriveLink: designReady ? (designLines[0]?.designDriveLink ?? null) : order.designDriveLink },
    select: { id: true, designReady: true, pipelineStatus: true },
  })
}

export async function applyLineProps(orderId: string, props: ShopifyOrderLineProps[]) {
  const lines = await prisma.orderLine.findMany({ where: { orderId }, orderBy: { linePosition: 'asc' }, select: { id: true, sku: true, productTitle: true } })
  const byPosition = lines.length === props.length
  let updated = 0, unmatched = 0
  const used = new Set<string>()
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    const line = byPosition
      ? lines[i]
      : lines.find(l => !used.has(l.id) && (l.sku ?? '') === (p.sku ?? '') && l.productTitle === p.title)
    if (!line) { unmatched++; continue }
    used.add(line.id)
    const attrs = p.productUrl ? [...p.customAttributes, { key: '_product_url', value: p.productUrl }] : p.customAttributes
    await prisma.orderLine.update({ where: { id: line.id }, data: { customAttributesJson: JSON.stringify(attrs), imageUrl: p.imageUrl ?? null } })
    updated++
  }
  return { updated, unmatched }
}

export async function refreshMissingLineProps(orders: Array<{
  id: string; shopifyOrderNumber: string; store: { shop: string }
  lines: Array<{ customAttributesJson: string | null; imageUrl: string | null }>
}>): Promise<{ refreshed: number; notFound: number; otherStore: number; error: string | null }> {
  const result = { refreshed: 0, notFound: 0, otherStore: 0, error: null as string | null }
  const needing = orders.filter(o => o.lines.some(l => l.customAttributesJson == null || l.imageUrl == null))
  if (needing.length === 0) return result
  const conn = await getShopifyConnection()
  if (!conn) return { ...result, error: 'Chưa kết nối Shopify' }
  const mine = needing.filter(o => o.store.shop === conn.shop)
  result.otherStore = needing.length - mine.length
  if (mine.length === 0) return result
  let props: Map<string, ShopifyOrderLineProps[]>
  try {
    props = await fetchOrderLinePropsByNames(conn.shop, conn.token, mine.map(o => o.shopifyOrderNumber))
  } catch (e: any) {
    return { ...result, error: e.message }
  }
  for (const o of mine) {
    const p = props.get(o.shopifyOrderNumber)
    if (!p) { result.notFound++; continue }
    await applyLineProps(o.id, p)
    result.refreshed++
  }
  return result
}
