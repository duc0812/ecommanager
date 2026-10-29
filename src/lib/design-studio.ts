import { prisma } from '@/lib/db'
import { countryCodeOf, countryNameOf } from '@/lib/shipping-address'
import { visibleCustomAttributes, customerDesignLink, addOnSummaries, type AddOnSummary } from '@/lib/order-classify'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { isNonProductLine } from '@/lib/order-lines'
import { lineDesignStatus, type LineDesignStatus } from '@/lib/design-status'
import { loadReadyDesignEntries } from '@/lib/repos/design-library'
import { matchDesignEntry } from '@/lib/design-parent'
import { autoDetectStatus, type PipelineStatus } from '@/lib/pipeline-status'
import { fetchOrderLinePropsByNames, type ShopifyOrderLineProps } from '@/lib/shopify-orders'
import { getShopifyConnection } from '@/lib/token-store'
import { reconcilePushedOrder } from '@/lib/repos/push-export'
import { clearLineExports } from '@/lib/repos/orders'
import { fileKindOf, folderHoldsPrintFiles, missingPrintAreas, orderedPrintFiles, type FileKind } from '@/lib/task-files'
import { customizationIdOf, parseCustomallFields } from '@/lib/customall-fields'

export type CustomAttribute = { key: string; value: string }
/** A field the customer filled; `source: 'customall'` = read back from the Customall app, not a Shopify line property. */
export type PersonalizationField = CustomAttribute & { source?: 'customall' }
export type SourcePrintFile = { printArea: string; url: string }
export type ArtworkRow = {
  id: string; kind: FileKind; printArea: string; version: number; fileName: string; size: number
  mimeType: string; uploadedById: string | null; createdAt: string; url: string
  widthPx: number | null; heightPx: number | null
  storage: ArtworkStorage; driveWebViewLink: string | null; driveFileId: string | null
  source: 'MANUAL' | 'AUTO'; previewUrl: string | null
}
export type ArtworkStorage = 'LOCAL' | 'DRIVE'
export type WorkspaceLine = {
  id: string; shopifyLineId: string; linePosition: number; sku: string | null; productTitle: string; variantTitle: string | null
  qty: number; isNonProduct: boolean; customized: boolean
  variantOptions: Record<string, string>
  attributesLoaded: boolean
  personalization: PersonalizationField[]
  /** The line is a Customall order whose typed text has not been read from Customall yet. */
  customallPending: boolean
  customerDesignLink: string | null
  customizedUrl: string | null
  previewUrl: string | null
  imageUrl: string | null
  /** imageUrl is the variant's own image (a variant mockup); false = the product's image; null = not known (older sync) */
  imageIsVariant: boolean | null
  sourcePrintFiles: SourcePrintFile[]
  supplier: { id: string; name: string; code: string; apiType?: string | null } | null
  supplierSku: string | null
  /** What the supplier SKU is in the supplier's catalogue ("Hoodie · M", "Cardigan · Crewneck"), so a wrong mapping shows. */
  supplierProduct: string | null
  templateUrl: string | null
  masterArtworkUrl: string | null
  libraryDesignLink: string | null
  designStatus: LineDesignStatus
  designDriveLink: string | null
  designNote: string | null
  printAreas: string[]
  artworks: ArtworkRow[]
}
/** Where the order ships: ISO2 code, country name and city / state, for routing the order to the right supplier. */
export type ShipTo = { countryCode: string | null; countryName: string | null; place: string | null }

function shipToOf(o: { shippingCountry: string | null; shippingCity: string | null; shippingState: string | null; shippingStateCode: string | null }): ShipTo {
  const countryCode = countryCodeOf(o.shippingCountry)
  return {
    countryCode,
    countryName: countryCode ? countryNameOf(countryCode) : (o.shippingCountry || null),
    place: [o.shippingCity, o.shippingStateCode ?? o.shippingState].filter(Boolean).join(', ') || null,
  }
}

export type Workspace = {
  order: {
    id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: string; orderType: string
    designReady: boolean; trelloCardUrl: string | null
    shipTo: ShipTo
    addOns: AddOnSummary[]
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

// Small renderings for lists and strips; the full file is only loaded when it is opened.
const THUMBABLE = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export function toArtworkRow(a: {
  id: string; kind?: string | null; printArea: string; version: number; fileName: string; size: number; mimeType: string; uploadedById: string | null
  createdAt: Date; widthPx: number | null; heightPx: number | null; storage: string; driveWebViewLink: string | null; driveFileId?: string | null
  source?: string | null; previewPath?: string | null
}): ArtworkRow {
  return {
    id: a.id, kind: fileKindOf(a.kind), printArea: a.printArea, version: a.version, fileName: a.fileName, size: a.size,
    mimeType: a.mimeType, uploadedById: a.uploadedById, createdAt: a.createdAt.toISOString(), url: artworkUrl(a.id),
    widthPx: a.widthPx, heightPx: a.heightPx,
    storage: a.storage === 'DRIVE' ? 'DRIVE' : 'LOCAL', driveWebViewLink: a.driveWebViewLink, driveFileId: a.driveFileId ?? null,
    source: a.source === 'AUTO' ? 'AUTO' : 'MANUAL', previewUrl: a.previewPath ? `${artworkUrl(a.id)}?preview=1` : THUMBABLE.includes(a.mimeType) ? `${artworkUrl(a.id)}?thumb=1` : null,
  }
}

export function artworkDesignLink(a: { id: string; storage: string; driveWebViewLink: string | null }): string {
  return a.storage === 'DRIVE' && a.driveWebViewLink ? a.driveWebViewLink : artworkUrl(a.id)
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
      artworks: { where: { removedAt: null }, orderBy: [{ printArea: 'asc' }, { version: 'desc' }] },
    },
  })
  if (!order) return null
  if (!order.store.project) return null

  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const skus = Array.from(new Set(order.lines.map(l => l.sku).filter(Boolean) as string[]))
  const productIds = Array.from(new Set(order.lines.map(l => l.shopifyProductId).filter(Boolean) as string[]))
  const [suppliers, supplierProducts, skuDesigns, designEntries, profiles] = await Promise.all([
    supplierIds.length ? prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, code: true, apiType: true } }) : [],
    supplierIds.length
      ? prisma.supplierProduct.findMany({
          where: { supplierId: { in: supplierIds }, sku: { in: order.lines.map(l => l.resolvedSupplierSku).filter(Boolean) as string[] } },
          select: { supplierId: true, sku: true, designTemplateUrl: true, productName: true, variant1Value: true, variant2Value: true },
        })
      : [],
    skus.length ? prisma.skuDesign.findMany({ where: { sku: { in: skus } }, select: { sku: true, driveLink: true } }) : [],
    loadReadyDesignEntries(),
    productIds.length
      ? prisma.productProfile.findMany({ where: { storeId: order.storeId, shopifyProductId: { in: productIds } }, select: { shopifyProductId: true, masterArtworkUrl: true } })
      : [],
  ])
  const profileMasterByProduct = new Map(profiles.map(p => [p.shopifyProductId, safeHttpUrl(p.masterArtworkUrl)]))
  const supplierById = new Map(suppliers.map(s => [s.id, s]))
  const templateByKey = new Map(supplierProducts.map(p => [`${p.supplierId}::${p.sku}`, p.designTemplateUrl]))
  const supplierProductByKey = new Map(supplierProducts.map(p => [`${p.supplierId}::${p.sku}`,
    [p.productName, p.variant1Value, p.variant2Value].filter(Boolean).join(' · ') || null]))
  const masterBySku = new Map(skuDesigns.map(d => [d.sku, d.driveLink]))

  const lines: WorkspaceLine[] = order.lines.map(l => {
    const attrs = parseAttributes(l.customAttributesJson)
    const isNonProduct = isNonProductLine(l)
    const entry = matchDesignEntry(l.sku, l.resolvedSupplierId, designEntries)
    const preview = l.previewCdnUrl ?? extractPreviewCdnUrl(attrs)
    const productUrl = safeHttpUrl(lastAttr(attrs, '_product_url'))
    const artworks = order.artworks.filter(a => a.shopifyLineId === l.shopifyLineId)
    const customall = parseCustomallFields(l.customallFieldsJson)
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
      personalization: [
        ...visibleCustomAttributes(attrs).filter(a => a.value !== preview),
        ...(customall ?? []).map(f => ({ ...f, source: 'customall' as const })),
      ],
      customallPending: customall === null && customizationIdOf(attrs) !== null,
      customerDesignLink: safeCustomerDesignLink(attrs, productUrl, l.shopifyVariantId),
      customizedUrl: safeHttpUrl(attrs.find(a => a.key === '_customized_url')?.value),
      previewUrl: safeHttpUrl(preview),
      imageUrl: safeHttpUrl(l.imageUrl),
      imageIsVariant: l.imageIsVariant ?? null,
      sourcePrintFiles: sourcePrintFiles(attrs).flatMap(f => {
        const url = safeHttpUrl(f.url)
        return url ? [{ printArea: f.printArea, url }] : []
      }),
      supplier: l.resolvedSupplierId ? (supplierById.get(l.resolvedSupplierId) ?? null) : null,
      supplierSku: l.resolvedSupplierSku,
      supplierProduct: l.resolvedSupplierId && l.resolvedSupplierSku ? (supplierProductByKey.get(`${l.resolvedSupplierId}::${l.resolvedSupplierSku}`) ?? null) : null,
      templateUrl: l.resolvedSupplierId && l.resolvedSupplierSku ? safeHttpUrl(templateByKey.get(`${l.resolvedSupplierId}::${l.resolvedSupplierSku}`)) : null,
      masterArtworkUrl: (l.shopifyProductId ? profileMasterByProduct.get(l.shopifyProductId) : null)
        ?? (l.sku ? safeHttpUrl(masterBySku.get(l.sku)) : null),
      libraryDesignLink: safeHttpUrl(entry?.designLink),
      designStatus: lineDesignStatus({
        isNonProduct, previewCdnUrl: l.previewCdnUrl, designDriveLink: l.designDriveLink,
        hasLibraryDesign: !!entry, customized: l.customized,
      }),
      designDriveLink: l.designDriveLink,
      designNote: l.designNote,
      printAreas: printAreasForLine(attrs),
      artworks: artworks.map(toArtworkRow),
    }
  })

  return {
    order: {
      id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, placedAt: order.placedAt.toISOString(),
      pipelineStatus: order.pipelineStatus, orderType: order.orderType, designReady: order.designReady,
      trelloCardUrl: safeHttpUrl(order.trelloCardUrl),
      shipTo: shipToOf(order),
      addOns: addOnSummaries(order.lines.map(l => ({
        sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType, variantTitle: l.variantTitle, qty: l.qty,
        customAttributes: parseAttributes(l.customAttributesJson),
      }))),
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
    const [files, task] = await Promise.all([
      prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }),
      prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: line.orderId, shopifyLineId: line.shopifyLineId } }, select: { driveFolderUrl: true } }),
    ])
    const areas = patch.requiredAreas ?? []
    const live = files.filter(a => !a.removedAt)
    const missing = missingPrintAreas(live, areas)
    if (missing.length > 0) throw new Error(`No artwork uploaded for: ${missing.join(', ')}`)
    const prints = orderedPrintFiles(live, areas)
    if (prints.length === 0) throw new Error('No artwork uploaded: the task needs at least one print file')
    // The factory gets the task folder once it holds every print file; until then the line keeps a single-file link the export translates.
    data.designDriveLink = task?.driveFolderUrl && folderHoldsPrintFiles(files) ? task.driveFolderUrl : artworkDesignLink(prints[0])
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
  // A handoff is stale once a line is reopened or the factory sent the file back: the new design has to be handed over again.
  const staleHandoff = !!order.supplierHandoffAt && !['EXPORTED', 'FULFILLED'].includes(pipelineStatus)
    && (!designReady || (markedDone && order.pipelineStatus === 'DESIGN_REJECTED'))
  // Re-approved after the factory sent the design back: every task was reopened, so every line goes to its supplier again.
  if (markedDone && designReady && order.pipelineStatus === 'DESIGN_REJECTED') await clearLineExports([orderId])
  const select = { id: true, designReady: true, pipelineStatus: true } as const
  const updated = await prisma.order.update({
    where: { id: orderId },
    data: {
      designReady, pipelineStatus, designDriveLink: designReady ? (designLines[0]?.designDriveLink ?? null) : order.designDriveLink,
      ...(staleHandoff ? { supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null } : {}),
    },
    select,
  })
  if (markedDone && updated.pipelineStatus === 'READY_TO_PRODUCTION' && await reconcilePushedOrder(orderId)) {
    return prisma.order.findUniqueOrThrow({ where: { id: orderId }, select })
  }
  return updated
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
    await prisma.orderLine.update({ where: { id: line.id }, data: { customAttributesJson: JSON.stringify(attrs), imageUrl: p.imageUrl ?? null, imageIsVariant: p.imageUrl ? (p.imageIsVariant ?? null) : null, ...(p.productId !== undefined ? { shopifyProductId: p.productId } : {}) } })
    updated++
  }
  return { updated, unmatched }
}

export function needsLineProps(order: { lines: Array<{ customAttributesJson: string | null; imageUrl: string | null; shopifyProductId: string | null }> }): boolean {
  return order.lines.some(l => l.customAttributesJson == null || l.imageUrl == null || l.shopifyProductId == null)
}

export async function refreshMissingLineProps(orders: Array<{
  id: string; shopifyOrderNumber: string; store: { shop: string }
  lines: Array<{ customAttributesJson: string | null; imageUrl: string | null; shopifyProductId: string | null }>
}>): Promise<{ refreshed: number; notFound: number; otherStore: number; error: string | null }> {
  const result = { refreshed: 0, notFound: 0, otherStore: 0, error: null as string | null }
  const needing = orders.filter(needsLineProps)
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
