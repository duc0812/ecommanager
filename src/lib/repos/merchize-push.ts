import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { requiredSlotsFor, taskKeyFor, templateForLine } from '@/lib/design-tasks'
import { artworkUrl } from '@/lib/design-studio'
import { currentFiles, extraPrintParts } from '@/lib/task-files'
import { logHandoffEvent, markPushExported } from '@/lib/repos/push-export'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { retryOnBusy } from '@/lib/sqlite-busy'
import { SHIPMENT_STATUS_FULFILLED, SHIPMENT_STATUS_PENDING } from '@/lib/tracking/build-shipments'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { PublicUrlError, ensurePublicToken, isLineApproved, publicArtworkUrl, requirePublicBaseUrl } from '@/lib/public-artwork'
import { expectedSize, printFileFit } from '@/lib/print-file-fit'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  MerchizeError, cancelOrder, createOrder, getOrderDetail, isMerchizeSupplier, merchizeCredentials, merchizePrintingMethod,
  pushToProduction, searchCatalog, serializeOrderPayload,
  type MerchizeCatalogVariant, type MerchizeCredentials, type MerchizePrintingMethod, type MerchizeOrderItem, type MerchizeOrderPayload,
} from '@/lib/merchize'
import type { PreviewFile, PreviewIssue, PreviewLine, PushPreview, PushStatus, PushView } from '@/lib/pgprints-shared'

const ACTIVE_STATUSES: PushStatus[] = ['SENDING', 'CREATED']
const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
const EXPORT_READY = ['READY_TO_PRODUCTION', 'EXPORTED']
const UNKNOWN_RESULT_GRACE_MS = 2 * 60_000
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi Merchize đang hiệu lực — không gửi trùng'
type DesignField = 'design_front' | 'design_back' | 'design_sleeve' | 'design_hood'
// Specific sides first: "Artwork" alone (one-part templates) is the front, "Back Artwork" is not.
const SIDES: Array<{ field: DesignField; match: RegExp }> = [
  { field: 'design_back', match: /back|mặt sau/i },
  { field: 'design_sleeve', match: /sleeve|tay/i },
  { field: 'design_hood', match: /hood|mũ/i },
  { field: 'design_front', match: /front|mặt trước|artwork/i },
]

type PushRow = Awaited<ReturnType<typeof prisma.supplierOrderPush.findUniqueOrThrow>>

const isActive = (status: string) => (ACTIVE_STATUSES as string[]).includes(status)
const activeKeyFor = (orderId: string, supplierId: string) => `${orderId}::${supplierId}`

function httpsUrl(v: string | null | undefined): string | null {
  if (!v) return null
  try { return new URL(v).protocol === 'https:' ? v : null } catch { return null }
}

function isUniqueViolation(e: any): boolean {
  if (e?.code === 'P2002') return true
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  return msg.includes('UNIQUE constraint failed') || msg.includes('Unique constraint failed')
}

/** The store default (DTF) unless the blank does not offer it: Gildan 18600US is DTG only. */
export function methodFor(variant: { methods: string[] } | undefined, preferred: MerchizePrintingMethod): MerchizePrintingMethod {
  const offered = (variant?.methods ?? []).map(m => m.toUpperCase()).filter((m): m is MerchizePrintingMethod => m === 'DTF' || m === 'DTG')
  return offered.length === 0 || offered.includes(preferred) ? preferred : offered[0]
}

/** The Merchize print side a part name stands for; "Artwork" (one-part templates) is the front. */
export function merchizeSideOf(area: string): DesignField | null {
  return SIDES.find(s => s.match.test(area))?.field ?? null
}

/** Stable per store, so external_number lookups never collide across stores. */
export function merchizeIdentifier(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, '').toLowerCase()
}

export async function findMerchizeSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isMerchizeSupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

async function toPushViews(rows: PushRow[]): Promise<PushView[]> {
  const userIds = Array.from(new Set(rows.map(r => r.pushedById).filter((x): x is string => !!x)))
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))
  return rows.map(r => ({
    id: r.id, status: r.status as PushStatus, externalOrderId: r.externalOrderId, supplierOrderCode: r.supplierOrderCode,
    remoteStatus: r.remoteStatus, totalCost: r.totalCost, shippingFee: r.shippingFee, handleFee: r.handleFee, error: r.error,
    pushedAt: r.pushedAt.toISOString(), pushedByName: r.pushedById ? (nameById.get(r.pushedById) ?? null) : null,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null, lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
  }))
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

  const creds = merchizeCredentials()
  const supplier = await findMerchizeSupplier()
  const printingMethod = merchizePrintingMethod()
  const identifier = merchizeIdentifier(order.store.shop)
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const active = pushes.find(p => isActive(p.status)) ?? null
  const cancelledCount = pushes.filter(p => p.status === 'CANCELLED').length
  // A cancelled Merchize order keeps its external number, so a re-send after a cancel needs a fresh one.
  const externalOrderId = cancelledCount > 0 ? `${orderNo}-R${cancelledCount + 1}` : orderNo

  if (!supplier) error('NO_SUPPLIER', 'Chưa có xưởng mã "merchize" trong danh sách xưởng')
  if (!creds) error('NO_CREDENTIALS', 'Server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN')
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
  if (productLines.length === 0) error('NO_LINES', 'Đơn không có dòng sản phẩm nào để gửi')
  const unmapped = productLines.filter(l => !l.resolvedSupplierId)
  const foreign = productLines.filter(l => l.resolvedSupplierId && l.resolvedSupplierId !== supplier?.id)
  if (unmapped.length > 0) error('UNMAPPED_LINE', `Dòng ${unmapped.map(l => taskKeyFor(order.shopifyOrderNumber, l.linePosition)).join(', ')} chưa map xưởng`)
  if (supplier && foreign.length > 0) {
    const others = await prisma.supplier.findMany({ where: { id: { in: foreign.map(l => l.resolvedSupplierId as string) } }, select: { name: true } })
    error('MIXED_SUPPLIER', `Đơn có dòng thuộc xưởng khác (${others.map(s => s.name).join(', ') || 'không rõ'}) — chỉ gửi được đơn mà mọi dòng đều của Merchize`)
  }
  const pushLines = supplier ? productLines.filter(l => l.resolvedSupplierId === supplier.id) : []
  // A line already exported to Merchize another way (CSV import) is an order Merchize already holds; an API create would duplicate it.
  const exportedElsewhere = active ? [] : pushLines.filter(l => l.exportedAt && l.exportedToSupplierId === supplier?.id)
  if (exportedElsewhere.length > 0) {
    const when = exportedElsewhere[0].exportedAt!.toISOString().replace('T', ' ').slice(0, 16)
    error('ALREADY_EXPORTED', `Dòng ${exportedElsewhere.map(l => taskKeyFor(order.shopifyOrderNumber, l.linePosition)).join(', ')} đã xuất cho Merchize lúc ${when} UTC (CSV) — gửi API nữa sẽ thành đơn trùng`)
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
    const refId = taskKeyFor(order.shopifyOrderNumber, l.linePosition)
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
      const art = prints.find(a => a.printArea === area) ?? null
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
      const side = merchizeSideOf(area)
      if (!side) error('UNKNOWN_SIDE', `${refId}: vùng in "${area}" không ứng với mặt nào của Merchize (front / back / sleeve / hood)`, refId)
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
      refId, lineId: l.id, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku, shipClass: method, shipClassSource: method === printingMethod ? 'default' : 'product', shipCountries: [],
      templateName: template?.name ?? null, mockupUrl, designNote: note, files,
    })
    items.push({
      name: l.variantTitle ? `${l.productTitle} - ${l.variantTitle}` : l.productTitle,
      sku: apiSku ?? '', merchize_sku: apiSku ?? '', product_id: variant?.productId ?? '',
      quantity: l.qty, price: l.unitPrice, currency: order.currency || 'USD', printing_method: method, image: image ?? '',
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
      canPush: !!payload && !hasErrors && !!creds,
      payload,
      payloadHash: rawBody ? hashPayload(rawBody) : null,
      lines,
      issues,
      balance: null,
      activePush: views.find(v => isActive(v.status)) ?? null,
      history: views,
    },
  }
}

async function reservePush(input: { orderId: string; supplierId: string; externalOrderId: string; requestJson: string; userId: string | null }): Promise<{ id: string; pushedAt: Date }> {
  const activeKey = activeKeyFor(input.orderId, input.supplierId)
  const pushedAt = new Date()
  try {
    return await retryOnBusy(() => prisma.$transaction(async tx => {
      const existing = await tx.supplierOrderPush.findMany({ where: { orderId: input.orderId, supplierId: input.supplierId } })
      if (existing.some(p => isActive(p.status))) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
      const fresh = {
        status: 'SENDING', activeKey, requestJson: input.requestJson, responseJson: null, error: null,
        supplierOrderCode: null, supplierInternalId: null, remoteStatus: null, totalCost: null, shippingFee: null, handleFee: null,
        pushedById: input.userId, pushedAt, cancelledAt: null, lastSyncedAt: null, exportMarked: false, prevExportJson: null,
      }
      const failed = existing.find(p => p.status === 'FAILED' && p.externalOrderId === input.externalOrderId)
      if (failed) {
        const r = await tx.supplierOrderPush.updateMany({ where: { id: failed.id, status: 'FAILED' }, data: fresh })
        if (r.count !== 1) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
        return { id: failed.id, pushedAt }
      }
      const row = await tx.supplierOrderPush.create({
        data: { orderId: input.orderId, supplierId: input.supplierId, externalOrderId: input.externalOrderId, ...fresh },
      })
      return { id: row.id, pushedAt }
    }))
  } catch (e: any) {
    if (e instanceof PushError) throw e
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
}

async function viewOf(pushId: string): Promise<PushView> {
  const row = await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: pushId } })
  return (await toPushViews([row]))[0]
}

export async function pushMerchizeOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const creds = merchizeCredentials()
  if (!creds) throw new PushError('Server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN', 400, 'NO_CREDENTIALS')
  const built = await buildMerchizePush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi Merchize', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }

  const reserved = await reservePush({
    orderId, supplierId: built.supplierId, externalOrderId: built.externalOrderId, requestJson: built.rawBody, userId: input.userId,
  })

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

async function latestPush(orderId: string, supplierId: string, statuses: PushStatus[]): Promise<PushRow | null> {
  return prisma.supplierOrderPush.findFirst({ where: { orderId, supplierId, status: { in: statuses } }, orderBy: { createdAt: 'desc' } })
}

async function identifierFor(orderId: string): Promise<string> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { store: { select: { shop: true } } } })
  return merchizeIdentifier(order.store.shop)
}

export async function cancelMerchizePush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findMerchizeSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi Merchize nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const creds = merchizeCredentials()
  if (!creds) throw new PushError('Server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN', 400, 'NO_CREDENTIALS')
  try {
    await cancelOrder(creds, push.externalOrderId, await identifierFor(orderId))
  } catch (e: any) {
    throw new PushError(`Merchize không huỷ được đơn: ${e?.message ?? e}`, e instanceof MerchizeError && e.noResponse ? 504 : 502, 'CANCEL_FAILED')
  }
  const r = await prisma.supplierOrderPush.updateMany({
    where: { id: push.id, status: 'CREATED' },
    data: { status: 'CANCELLED', activeKey: null, cancelledAt: new Date() },
  })
  let exportReverted = false
  if (r.count === 1 && push.exportMarked) {
    let prev: {
      pipelineStatus?: string; exportedAt?: string | null; exportedToSupplierId?: string | null
      supplierHandoffAt?: string | null; supplierHandoffMode?: string | null; supplierHandoffById?: string | null
    } = {}
    try { prev = JSON.parse(push.prevExportJson ?? '{}') } catch {}
    const reverted = await prisma.order.updateMany({
      where: { id: orderId, pipelineStatus: 'EXPORTED', exportedToSupplierId: push.supplierId, exportedAt: push.pushedAt },
      data: {
        pipelineStatus: prev.pipelineStatus ?? 'READY_TO_PRODUCTION',
        exportedAt: prev.exportedAt ? new Date(prev.exportedAt) : null,
        exportedToSupplierId: prev.exportedToSupplierId ?? null,
        supplierHandoffAt: prev.supplierHandoffAt ? new Date(prev.supplierHandoffAt) : null,
        supplierHandoffMode: prev.supplierHandoffAt ? (prev.supplierHandoffMode ?? null) : null,
        supplierHandoffById: prev.supplierHandoffAt ? (prev.supplierHandoffById ?? null) : null,
      },
    })
    const stillExported = reverted.count === 0 && (await prisma.order.count({ where: { id: orderId, pipelineStatus: 'EXPORTED' } })) > 0
    const lines = stillExported ? { count: 0 } : await prisma.orderLine.updateMany({
      where: { orderId, exportedToSupplierId: push.supplierId, exportedAt: push.pushedAt },
      data: { exportedAt: null, exportedToSupplierId: null },
    })
    exportReverted = reverted.count === 1 || lines.count > 0
    if (exportReverted) await logHandoffEvent(orderId, 'Huỷ đơn bên Merchize — đơn trở lại chờ chuyển xưởng', null)
  }
  return { push: await viewOf(push.id), exportReverted }
}

async function upsertTracking(push: PushRow, tracking: { number: string; company: string | null }[]): Promise<number> {
  if (tracking.length === 0) return 0
  const order = await prisma.order.findUnique({
    where: { id: push.orderId },
    select: {
      id: true, projectId: true, shopifyOrderNumber: true,
      lines: { orderBy: { linePosition: 'asc' }, select: { shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true, resolvedSupplierId: true } },
    },
  })
  if (!order) return 0
  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  // Shipment.lineKey numbers product lines only (see buildOrderShipments); Merchize ships the order as one package.
  const productLines = order.lines.filter(l => !isNonProductLine(l))
  const t = tracking[0]
  let touched = 0
  for (let index = 0; index < productLines.length; index++) {
    const line = productLines[index]
    if (line.resolvedSupplierId !== push.supplierId) continue
    const lineKey = `${orderNo}_${index + 1}`
    const existing = await prisma.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } } })
    if (!existing) {
      await prisma.shipment.create({
        data: {
          orderId: order.id, projectId: order.projectId, lineKey, shopifyLineId: line.shopifyLineId, sku: line.sku, productTitle: line.productTitle,
          supplierId: push.supplierId, trackingNumber: t.number, carrier: t.company, status: SHIPMENT_STATUS_FULFILLED,
        },
      })
      touched++
      continue
    }
    if (existing.shopifyFulfillmentId && existing.trackingNumber) continue
    await prisma.shipment.update({
      where: { id: existing.id },
      data: {
        trackingNumber: t.number, carrier: t.company ?? existing.carrier, supplierId: existing.supplierId ?? push.supplierId,
        ...(existing.status === SHIPMENT_STATUS_PENDING ? { status: SHIPMENT_STATUS_FULFILLED } : {}),
      },
    })
    touched++
  }
  return touched
}

export async function refreshMerchizePush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findMerchizeSupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi Merchize', 404, 'NOT_FOUND')
  const creds = merchizeCredentials()
  if (!creds) throw new PushError('Server chưa có MERCHIZE_API_URL / MERCHIZE_API_TOKEN', 400, 'NO_CREDENTIALS')
  const now = Date.now()
  let remote: Awaited<ReturnType<typeof getOrderDetail>>
  try {
    remote = await getOrderDetail(creds, push.externalOrderId, await identifierFor(orderId))
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
    return { push: await viewOf(push.id), found: false, shipments: 0 }
  }
  const landed = push.status === 'SENDING' || push.status === 'FAILED'
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remote.status ?? push.remoteStatus,
        supplierOrderCode: push.supplierOrderCode ?? remote.code, supplierInternalId: push.supplierInternalId ?? remote.id,
        totalCost: remote.fulfillmentCost ?? push.totalCost, shippingFee: remote.shippingCost ?? push.shippingFee,
        ...(landed ? { status: 'CREATED', error: null, activeKey: activeKeyFor(push.orderId, push.supplierId) } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  const shipments = push.status === 'CANCELLED' ? 0 : await upsertTracking(push, remote.tracking)
  return { push: await viewOf(push.id), found: true, shipments }
}
