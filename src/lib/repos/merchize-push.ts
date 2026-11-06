import { prisma } from '@/lib/db'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { requiredSlotsFor, templateForLine } from '@/lib/design-tasks'
import { artworkUrl } from '@/lib/design-studio'
import { currentFiles, extraPrintParts, sameLabel } from '@/lib/task-files'
import { heldLinesMessage, logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { PublicUrlError, ensurePublicToken, isLineApproved, publicArtworkUrl, requirePublicBaseUrl } from '@/lib/public-artwork'
import { expectedSize, printFileFit } from '@/lib/print-file-fit'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  ACTIVE_STATUSES, CLOSED_FINANCIAL, CLOSED_PIPELINE, EXPORT_READY, UNKNOWN_RESULT_GRACE_MS, activeKeyFor, closeCancelledPush, httpsUrl, isActive,
  isUniqueViolation, latestPush, pushCarriedLines, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow,
} from '@/lib/repos/supplier-push-core'
import { safeErrorText } from '@/lib/store-jobs'
import {
  MerchizeError, cancelOrder, createOrder, getOrderDetail, isMerchizeSupplier, merchizeMissingMessage, merchizePrintingMethod, resolveMerchize,
  pushToProduction, searchCatalog, serializeOrderPayload,
  type MerchizeCatalogVariant, type MerchizeCredentials, type MerchizePrintingMethod, type MerchizeOrderItem, type MerchizeOrderPayload,
} from '@/lib/merchize'
import type { PreviewFile, PreviewIssue, PreviewLine, PushPreview, PushView } from '@/lib/pgprints-shared'

const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi Merchize đang hiệu lực — không gửi trùng'
// As Bondre and Printway: tracking stops being worth asking for long before this; it keeps a stuck push from being asked about forever.
const TRACKING_WINDOW_DAYS = 90
type DesignField = 'design_front' | 'design_back' | 'design_sleeve' | 'design_hood'
// Specific sides first: "Artwork" alone (one-part templates) is the front, "Back Artwork" is not.
const SIDES: Array<{ field: DesignField; match: RegExp }> = [
  { field: 'design_back', match: /back|mặt sau/i },
  { field: 'design_sleeve', match: /sleeve|tay/i },
  { field: 'design_hood', match: /hood|mũ/i },
  { field: 'design_front', match: /front|mặt trước|artwork/i },
]

/**
 * The store default (DTF) unless the blank does not offer it: Gildan 18600US is DTG only. A catalog entry that lists no
 * printing method at all (AOP hoodie, acrylic magnet, wood) takes none: Merchize rejects "DTF is not supported" there.
 * An unknown variant (catalog unreachable) keeps the default.
 */
export function methodFor(variant: { methods: string[] } | undefined, preferred: MerchizePrintingMethod): MerchizePrintingMethod | null {
  if (variant && variant.methods.length === 0) return null
  const offered = (variant?.methods ?? []).map(m => m.toUpperCase()).filter((m): m is MerchizePrintingMethod => m === 'DTF' || m === 'DTG')
  return offered.length === 0 || offered.includes(preferred) ? preferred : offered[0]
}

/** The Merchize print side a part name stands for; "Artwork" (one-part templates) is the front. */
export function merchizeSideOf(area: string): DesignField | null {
  return SIDES.find(s => s.match.test(area))?.field ?? null
}

/**
 * The side of one part of a line. A part whose name says nothing about a side ("Print", "Sheet") is still the front when it is
 * the line's only part: a single-area template (AOP sheet, magnet, ornament) has nothing else it could be.
 */
export function merchizeSideForPart(area: string, allParts: string[]): DesignField | null {
  return merchizeSideOf(area) ?? (allParts.length === 1 ? 'design_front' : null)
}

/** Stable per store, so external_number lookups never collide across stores. The supplier sees the store's short name (LZ), not the shop domain. */
export function merchizeIdentifier(store: { shop: string; project?: { name: string } | null }): string {
  return store.project?.name?.trim() || store.shop.replace(/\.myshopify\.com$/i, '').toLowerCase()
}

export async function findMerchizeSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isMerchizeSupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

export type BuiltMerchizePush = {
  preview: PushPreview; rawBody: string | null; externalOrderId: string; identifier: string; supplierId: string | null
}

export async function buildMerchizePush(orderId: string): Promise<BuiltMerchizePush | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lines: { orderBy: { linePosition: 'asc' } },
      store: { include: { project: { select: { name: true } } } },
      designTasks: { select: { shopifyLineId: true, status: true } },
      artworks: { where: { removedAt: null }, orderBy: { version: 'desc' } },
    },
  })
  if (!order) return null

  const resolved = await resolveMerchize(order.storeId)
  const creds = resolved.creds
  const credentialsNote = resolved.creds ? null : merchizeMissingMessage(order.store.project?.name ?? order.store.shop, resolved.missing)
  const supplier = await findMerchizeSupplier()
  const printingMethod = merchizePrintingMethod()
  const identifier = merchizeIdentifier(order.store)
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const plan = planPushLines(order, order.lines.filter(l => !isNonProductLine(l) && !!supplier && l.resolvedSupplierId === supplier.id), pushes)
  const active = plan.later ? null : pushes.find(p => isActive(p.status)) ?? null
  // A cancelled Merchize order keeps its external number, so a re-send after a cancel needs a fresh one.
  const externalOrderId = await nextExternalOrderId(orderNo, { orderId, supplierId: supplier?.id ?? null, later: plan.later })

  if (!supplier) error('NO_SUPPLIER', 'Chưa có xưởng mã "merchize" trong danh sách xưởng')
  if (credentialsNote) error('NO_CREDENTIALS', credentialsNote)
  if (CLOSED_PIPELINE.includes(order.pipelineStatus) || CLOSED_FINANCIAL.includes((order.financialStatus ?? '').toUpperCase())) {
    error('ORDER_CLOSED', 'Đơn đã huỷ hoặc đã hoàn tiền — không gửi sản xuất')
  } else if (!EXPORT_READY.includes(order.pipelineStatus)) {
    const label = STATUS_LABELS[order.pipelineStatus as PipelineStatus] ?? order.pipelineStatus
    warning('PIPELINE_STATUS', `Đơn đang ở trạng thái "${label}" — gửi xong đơn sẽ không tự chuyển sang Exported`)
  }
  if ((order.financialStatus ?? '').toUpperCase() === 'PARTIALLY_REFUNDED') warning('PARTIAL_REFUND', 'Đơn đã hoàn tiền một phần — kiểm tra lại các dòng trước khi gửi')
  if (active) error('ACTIVE_PUSH', `Đơn đã được gửi sang Merchize (external number ${active.externalOrderId})`)
  const taken = await prisma.supplierOrderPush.findUnique({ where: { externalOrderId }, select: { orderId: true, supplierId: true } })
  if (taken && (taken.orderId !== orderId || taken.supplierId !== supplier?.id)) error('ORDER_ID_TAKEN', `Mã đơn ${externalOrderId} đã được dùng cho một lần gửi xưởng khác`)

  let baseUrl: string | null = null
  try {
    baseUrl = requirePublicBaseUrl()
  } catch (e: any) {
    if (!(e instanceof PublicUrlError)) throw e
    error('PUBLIC_URL', e.message)
  }

  const productLines = order.lines.filter(l => !isNonProductLine(l))
  const lineKeys = lineKeysOf(order.shopifyOrderNumber, order.lines)
  const keyOf = (l: { shopifyLineId: string }) => lineKeys.get(l.shopifyLineId) ?? l.shopifyLineId
  if (productLines.length === 0) error('NO_LINES', 'Đơn không có dòng sản phẩm nào để gửi')
  const unmapped = productLines.filter(l => !l.resolvedSupplierId)
  const foreign = productLines.filter(l => l.resolvedSupplierId && l.resolvedSupplierId !== supplier?.id)
  if (unmapped.length > 0) error('UNMAPPED_LINE', `Dòng ${unmapped.map(l => keyOf(l)).join(', ')} chưa map xưởng`)
  if (supplier && foreign.length > 0) {
    // Only the Merchize lines go out (owner 2026-10-29, LIT5235: the tee to Merchize, the hoodie stays with Mangoshao). The export
    // marks are per line, so the other lines stay open for their own supplier and the order turns EXPORTED once they are sent too.
    const others = await prisma.supplier.findMany({ where: { id: { in: foreign.map(l => l.resolvedSupplierId as string) } }, select: { name: true } })
    warning('MIXED_SUPPLIER', `Chỉ gửi các dòng Merchize; dòng ${foreign.map(l => keyOf(l)).join(', ')} thuộc ${others.map(s => s.name).join(', ') || 'xưởng khác'} — xuất riêng cho xưởng đó`)
  }
  const pushLines = plan.lines
  if (plan.held.length > 0) warning('DESIGN_OPEN', heldLinesMessage(plan.held.map(l => keyOf(l))))
  // A line already exported to Merchize another way (CSV import) is an order Merchize already holds; an API create would duplicate it.
  const exportedElsewhere = active ? [] : pushLines.filter(l => l.exportedAt && l.exportedToSupplierId === supplier?.id)
  if (exportedElsewhere.length > 0) {
    const when = exportedElsewhere[0].exportedAt!.toISOString().replace('T', ' ').slice(0, 16)
    error('ALREADY_EXPORTED', `Dòng ${exportedElsewhere.map(l => keyOf(l)).join(', ')} đã xuất cho Merchize lúc ${when} UTC (CSV) — gửi API nữa sẽ thành đơn trùng`)
  }

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: supplierSkus } }, select: { sku: true, apiSku: true, baseSku: true } })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  // The catalogue is read live: the variant's attributes are what Merchize expects on the item, and a SKU it dropped blocks the send.
  const catalogVariants = new Map<string, MerchizeCatalogVariant & { productId: string; methods: string[] }>()
  const parents = Array.from(new Set(products.map(p => p.baseSku).filter((x): x is string => !!x)))
  if (creds && parents.length > 0) {
    try {
      for (const p of await searchCatalog(creds, parents)) {
        for (const v of p.variants) catalogVariants.set(v.sku, { ...v, productId: p._id, methods: p.printing_methods ?? [] })
      }
    } catch (e: any) {
      error('CATALOG', `Không đọc được catalog Merchize: ${e?.message ?? e}`)
    }
  }

  const countryCode = countryCodeOf(order.shippingCountry)
  const lines: PreviewLine[] = []
  const items: MerchizeOrderItem[] = []

  for (const l of pushLines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const apiSku = product?.apiSku?.trim() || product?.sku || null
    const variant = apiSku ? catalogVariants.get(apiSku) : undefined
    if (!apiSku) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} không có trong bảng giá Merchize của app`, refId)
    else if (creds && catalogVariants.size > 0 && !variant) error('NOT_IN_CATALOG', `${refId}: Merchize không còn SKU ${apiSku} trong catalog`, refId)

    const template = await templateForLine(l)
    const slots = requiredSlotsFor(template)
    const lineFiles = order.artworks.filter(a => a.shopifyLineId === l.shopifyLineId)
    const prints = currentFiles(lineFiles, 'PRINT')
    const parts = [...slots, ...extraPrintParts(lineFiles, slots)]
    if (parts.length === 0) error('NO_ARTWORK', `${refId}: chưa có file in nào`, refId)
    const files: PreviewFile[] = []
    const designs: Partial<Record<DesignField, string>> = {}
    for (const area of parts) {
      const art = prints.find(a => sameLabel(a.printArea, area)) ?? null
      const target = slots.includes(area) ? expectedSize(template, area) : null
      if (!art) {
        error('NO_ARTWORK', `${refId}: chưa có file in cho vùng "${area}"`, refId)
        files.push({
          area, artworkId: null, fileName: null, mimeType: null, widthPx: null, heightPx: null,
          expectedWidthPx: target?.w ?? null, expectedHeightPx: target?.h ?? null, sizeOk: null, publicUrl: null, viewUrl: null, thumbUrl: null,
        })
        continue
      }
      if (art.mimeType !== 'image/png' && art.mimeType !== 'image/jpeg') {
        error('FILE_TYPE', `${refId}: file "${area}" (${art.fileName}) không phải PNG/JPEG — Merchize chỉ nhận link ảnh PNG hoặc JPEG`, refId)
      }
      const side = merchizeSideForPart(area, parts)
      if (!side) error('UNKNOWN_SIDE', `${refId}: vùng in "${area}" không ứng với mặt nào của Merchize (front / back / sleeve / hood) — một dòng nhiều mảnh phải đặt tên mảnh theo mặt`, refId)
      else if (designs[side]) error('DUPLICATE_SIDE', `${refId}: hai file cùng in mặt ${side.replace('design_', '')}`, refId)
      const fit = slots.includes(area) ? printFileFit(template, area, art) : null
      const sizeOk = fit?.state === 'ok' ? true : fit?.state === 'bad' ? false : null
      if (!template) warning('NO_TEMPLATE', `${refId}: SKU xưởng chưa gán template in — không đối chiếu được kích thước file`, refId)
      else if (sizeOk === false) warning('SIZE_MISMATCH', `${refId}: file "${area}" ${art.widthPx}×${art.heightPx}px khác khổ template ${target!.w}×${target!.h}px`, refId)
      let publicUrl: string | null = null
      if (baseUrl && approved) {
        publicUrl = publicArtworkUrl(baseUrl, await ensurePublicToken(art.id), art)
        if (side && !designs[side]) designs[side] = publicUrl
      }
      files.push({
        area, artworkId: art.id, fileName: art.fileName, mimeType: art.mimeType, widthPx: art.widthPx, heightPx: art.heightPx,
        expectedWidthPx: target?.w ?? null, expectedHeightPx: target?.h ?? null, sizeOk, publicUrl,
        viewUrl: artworkUrl(art.id), thumbUrl: art.previewPath ? `${artworkUrl(art.id)}?preview=1` : artworkUrl(art.id),
      })
    }
    const method = methodFor(variant, printingMethod)
    if (l.qty <= 0) error('BAD_QUANTITY', `${refId}: số lượng phải lớn hơn 0`, refId)

    const mockupFiles = currentFiles(lineFiles, 'MOCKUP')
      .filter(a => a.mimeType === 'image/png' || a.mimeType === 'image/jpeg')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    let image: string | null = null
    if (baseUrl && approved && mockupFiles[0]) image = httpsUrl(publicArtworkUrl(baseUrl, await ensurePublicToken(mockupFiles[0].id), mockupFiles[0]))
    image = image ?? httpsUrl(l.previewCdnUrl ?? l.imageUrl)
    if (!image) error('NO_MOCKUP', `${refId}: Merchize bắt buộc có ảnh sản phẩm (https) — dòng này không có`, refId)
    const mockupUrl = mockupFiles[0] ? artworkUrl(mockupFiles[0].id) : image
    const note = l.designNote?.trim() || null
    if (note) warning('DESIGN_NOTE', `${refId}: có ghi chú sản xuất — Merchize API không nhận ghi chú, báo xưởng riêng nếu cần`, refId)

    lines.push({
      refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku, shipClass: method, shipClassSource: method === printingMethod ? 'default' : 'product', shipCountries: [],
      templateName: template?.name ?? null, mockupUrl, designNote: note, files,
    })
    items.push({
      // Owner 11/03: the supplier sees neither the product title nor what the shopper paid.
      name: refId,
      sku: apiSku ?? '', merchize_sku: apiSku ?? '', product_id: variant?.productId ?? '',
      quantity: l.qty, price: 0, currency: order.currency || 'USD', ...(method ? { printing_method: method } : {}), image: image ?? '',
      ...designs,
      attributes: (variant?.attributes ?? []).map(a => ({ name: a.name, option: a.value_code })),
    })
  }

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const fullName = (order.shippingName ?? order.customerName ?? '').trim()
  const email = (order.customerEmail ?? '').trim()
  const phone = (order.shippingPhone ?? '').trim()
  if (!fullName) error('ADDRESS_NAME', 'Thiếu tên người nhận')
  if (!order.shippingAddress1?.trim()) error('ADDRESS_LINE', 'Thiếu địa chỉ giao hàng (address1)')
  if (!order.shippingCity?.trim()) error('ADDRESS_CITY', 'Thiếu thành phố giao hàng')
  if (!countryCode) error('ADDRESS_COUNTRY', `Không xác định được mã quốc gia từ "${order.shippingCountry ?? ''}"`)
  if (!order.shippingZip?.trim()) {
    if (countryCode === 'US' || countryCode === 'CA') error('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip)')
    else warning('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip)')
  }
  if (!stateCode && countryCode === 'US') error('ADDRESS_STATE', `Thiếu mã bang 2 chữ cho đơn Mỹ (bang: "${order.shippingState ?? ''}")`)
  if (!email) warning('ADDRESS_EMAIL', 'Thiếu email khách hàng')
  if (!phone) warning('ADDRESS_PHONE', 'Thiếu số điện thoại người nhận')

  let payload: MerchizeOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    payload = {
      order_id: externalOrderId,
      identifier,
      shipping_info: {
        full_name: fullName, address_1: order.shippingAddress1?.trim() ?? '', address_2: order.shippingAddress2?.trim() ?? '',
        city: order.shippingCity?.trim() ?? '', state: stateCode ?? order.shippingState?.trim() ?? '',
        postcode: order.shippingZip?.trim() ?? '', country: countryCode ?? '', email, phone,
      },
      items,
    }
  }
  const rawBody = payload ? serializeOrderPayload(payload) : null
  const views = await toPushViews(pushes)
  const hasErrors = issues.some(i => i.level === 'error')
  return {
    rawBody,
    externalOrderId,
    identifier,
    supplierId: supplier?.id ?? null,
    preview: {
      order: {
        id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus,
        storeName: order.store.project?.name ?? order.store.shop,
      },
      supplier,
      pushEnabled: !!creds,
      hasCredentials: !!creds,
      storeNote: credentialsNote,
      canPush: !!payload && !hasErrors && !!creds,
      payload,
      payloadHash: rawBody ? hashPayload(rawBody) : null,
      lines,
      issues,
      balance: null,
      activePush: views.find(v => isActive(v.status)) ?? null,
      laterSend: plan.later,
      history: views,
    },
  }
}

/** The Merchize account an order goes out under: its own store's, else the server's. */
async function credentialsForOrder(orderId: string): Promise<MerchizeCredentials> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { storeId: true, store: { select: { shop: true, project: { select: { name: true } } } } } })
  if (!order) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  const resolved = await resolveMerchize(order.storeId)
  if (!resolved.creds) throw new PushError(merchizeMissingMessage(order.store.project?.name ?? order.store.shop, resolved.missing), 400, 'NO_CREDENTIALS')
  return resolved.creds
}

export async function pushMerchizeOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const creds = await credentialsForOrder(orderId)
  const built = await buildMerchizePush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Merchize', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }

  const reserved = await reservePush({
    orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId, lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: built.rawBody, userId: input.userId,
  }, DUPLICATE_MESSAGE)

  let created: Awaited<ReturnType<typeof createOrder>>
  try {
    created = await createOrder(creds, built.rawBody)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    if (e instanceof MerchizeError && e.noResponse) {
      // No answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
      const text = `${message}. Chưa rõ Merchize đã nhận đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`
      await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text } })
      throw new PushError(text, 504, 'UNKNOWN_RESULT')
    }
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: {
        status: 'FAILED', activeKey: null, error: message,
        responseJson: e instanceof MerchizeError && e.body != null ? JSON.stringify(e.body).slice(0, 20_000) : null,
      },
    })
    throw new PushError(`Merchize từ chối đơn: ${message}`, 502, 'CREATE_FAILED')
  }

  const { code, note: pushNote } = await pushWhenImported(creds, built.externalOrderId, built.identifier)
  await prisma.supplierOrderPush.update({
    where: { id: reserved.id },
    data: {
      status: 'CREATED', error: pushNote, supplierInternalId: created.id, supplierOrderCode: code,
      remoteStatus: pushNote ? 'created' : 'pushed', responseJson: JSON.stringify(created.raw).slice(0, 200_000),
    },
  })
  const exported = await markPushExported({ id: reserved.id, orderId, supplierId: built.supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
  if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (Merchize) — external number ${built.externalOrderId}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

export const IMPORT_WAIT = { attempts: 8, delayMs: 1500 }

/**
 * Merchize imports an API order asynchronously: a push sent right after the create answers "Order not found"
 * (#LIT5000, 2026-10-28). Wait until order-detail sees the order, then push it into production.
 */
async function pushWhenImported(creds: MerchizeCredentials, externalNumber: string, identifier: string): Promise<{ code: string | null; note: string | null }> {
  let code: string | null = null
  for (let i = 0; i < IMPORT_WAIT.attempts && !code; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, IMPORT_WAIT.delayMs))
    code = await getOrderDetail(creds, externalNumber, identifier).then(o => o?.code ?? null, () => null)
  }
  try {
    await pushToProduction(creds, externalNumber, identifier)
    return { code, note: null }
  } catch (e: any) {
    // The order exists either way; an unpushed order only waits for "Push" on the Merchize dashboard.
    return { code, note: `Đã tạo đơn nhưng chưa đẩy vào sản xuất: ${e?.message ?? e} — bấm Push trên dashboard Merchize` }
  }
}

/** Merchize finds an order by the identifier it was sent under, and older pushes went under the shop domain. */
async function identifierFor(orderId: string, push: { requestJson: string | null }): Promise<string> {
  try {
    const sent = JSON.parse(push.requestJson ?? '{}').identifier
    if (typeof sent === 'string' && sent) return sent
  } catch { /* an unreadable request falls back to the store's current name */ }
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { store: { select: { shop: true, project: { select: { name: true } } } } } })
  return merchizeIdentifier(order.store)
}

export async function cancelMerchizePush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findMerchizeSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Merchize nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const creds = await credentialsForOrder(orderId)
  try {
    await cancelOrder(creds, push.externalOrderId, await identifierFor(orderId, push))
  } catch (e: any) {
    throw new PushError(`Merchize không huỷ được đơn: ${e?.message ?? e}`, e instanceof MerchizeError && e.noResponse ? 504 : 502, 'CANCEL_FAILED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên Merchize — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

/**
 * Merchize lists an order's fulfilments with a tracking number and carrier only, nothing that names an item. One tracking, or
 * one line, is written as it comes; several trackings over several lines cannot be split by line, so none is written.
 */
async function upsertTracking(push: PushRow, tracking: { number: string; company: string | null }[]): Promise<number> {
  const t = tracking[0]
  if (!t) return 0
  const numbers = new Set(tracking.map(x => x.number)).size
  if (numbers > 1) {
    const found = await pushCarriedLines(push)
    if (found && found.lines.length > 1) {
      console.warn(`[merchize] ${found.order.shopifyOrderNumber}: ${numbers} tracking khác nhau cho ${found.lines.length} dòng, Merchize không ghi kiện nào của dòng nào — không ghi tracking, cần đối chiếu tay`)
      return 0
    }
  }
  return upsertLineTracking(push, () => t)
}

export async function refreshMerchizePush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findMerchizeSupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi Merchize', 404, 'NOT_FOUND')
  const { found, shipments } = await refreshOne(await credentialsForOrder(orderId), push)
  return { push: await viewOf(push.id), found, shipments }
}

/** One push against Merchize, for the refresh button and the nightly pull alike: a found order lands it and brings its tracking. */
async function refreshOne(creds: MerchizeCredentials, push: PushRow): Promise<{ found: boolean; shipments: number }> {
  const now = Date.now()
  let remote: Awaited<ReturnType<typeof getOrderDetail>>
  try {
    remote = await getOrderDetail(creds, push.externalOrderId, await identifierFor(push.orderId, push))
  } catch (e: any) {
    throw new PushError(`Không lấy được trạng thái từ Merchize: ${e?.message ?? e}`, e instanceof MerchizeError && e.noResponse ? 504 : 502, 'REFRESH_FAILED')
  }
  const lastSyncedAt = new Date(now)
  if (!remote) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: stale
        ? { status: 'FAILED', activeKey: null, lastSyncedAt, error: 'Merchize không có đơn này — lần gửi không thành công, có thể gửi lại' }
        : { lastSyncedAt },
    })
    return { found: false, shipments: 0 }
  }
  const landed = push.status === 'SENDING' || push.status === 'FAILED'
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remote.status ?? push.remoteStatus,
        supplierOrderCode: push.supplierOrderCode ?? remote.code, supplierInternalId: push.supplierInternalId ?? remote.id,
        totalCost: remote.fulfillmentCost ?? push.totalCost, shippingFee: remote.shippingCost ?? push.shippingFee,
        ...(landed ? { status: 'CREATED', error: null, activeKey: push.activeKey ?? activeKeyFor(push.orderId, push.supplierId) } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  return { found: true, shipments: push.status === 'CANCELLED' ? 0 : await upsertTracking(push, remote.tracking) }
}

/**
 * Status and tracking of every open Merchize push (same window and order rules as Bondre and Printway), each pulled with the
 * account of its order's store (resolveMerchize). A store with no usable account is skipped and logged, never pulled with
 * another store's. One push or store failing does not stop the rest. Auto Fulfill turns the trackings into fulfillments.
 */
export async function syncMerchizeTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findMerchizeSupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no Merchize supplier' }
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const live = await prisma.supplierOrderPush.findMany({
    where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES }, pushedAt: { gte: since }, order: { pipelineStatus: { notIn: ['FULFILLED', ...CLOSED_PIPELINE] } } },
    include: { order: { select: { store: { select: { id: true, shop: true, project: { select: { name: true } } } } } } },
  })
  const byStore = new Map<string, { name: string; pushes: typeof live }>()
  for (const push of live) {
    const store = push.order.store
    const group = byStore.get(store.id) ?? { name: store.project?.name ?? store.shop, pushes: [] }
    group.pushes.push(push)
    byStore.set(store.id, group)
  }
  const total = { pushes: 0, found: 0, shipments: 0 }
  const withoutAccount: string[] = []
  for (const [storeId, { name, pushes }] of Array.from(byStore.entries())) {
    let resolved: Awaited<ReturnType<typeof resolveMerchize>>
    try {
      resolved = await resolveMerchize(storeId)
    } catch (e) {
      console.error(`[merchize] tracking sync failed for ${name}: ${safeErrorText(e)}`)
      continue
    }
    if (!resolved.creds) {
      console.log(`[merchize] tracking sync: ${name} has no usable Merchize account (missing ${resolved.missing}), skipped its ${pushes.length} live push(es)`)
      withoutAccount.push(name)
      continue
    }
    const creds = resolved.creds
    total.pushes += pushes.length
    for (const push of pushes) {
      try {
        const r = await refreshOne(creds, push)
        if (r.found) total.found++
        total.shipments += r.shipments
      } catch (e) {
        console.error('[merchize] tracking sync failed for push', push.id, safeErrorText(e, [creds.token, creds.baseUrl]))
      }
    }
  }
  return { ...total, ...(withoutAccount.length > 0 ? { skipped: `no Merchize credentials for ${withoutAccount.join(', ')}` } : {}) }
}
