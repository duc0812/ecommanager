import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { requiredSlotsFor, taskKeyFor, templateForLine } from '@/lib/design-tasks'
import { artworkUrl } from '@/lib/design-studio'
import { currentFiles, extraPrintParts } from '@/lib/task-files'
import { logHandoffEvent, markPushExported } from '@/lib/repos/push-export'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { retryOnBusy } from '@/lib/sqlite-busy'
import { SHIPMENT_STATUS_FULFILLED, SHIPMENT_STATUS_PENDING } from '@/lib/tracking/build-shipments'
import { PGPRINTS_ADDRESS_LINE_MAX, countryCodeOf, countryNameOf, resolveStateCode, splitAddressLine, splitPersonName } from '@/lib/shipping-address'
import { PublicUrlError, ensurePublicToken, isLineApproved, publicArtworkUrl, requirePublicBaseUrl } from '@/lib/public-artwork'
import { credentialsOf, getPgprintsSettings } from '@/lib/pgprints-settings'
import { expectedSize, printFileFit } from '@/lib/print-file-fit'
import {
  PgprintsError, cancelOrder, createOrder, getBalance, searchOrders, serializeOrderPayload,
  type PgprintsLineItem, type PgprintsOrderPayload, type PgprintsRemoteOrder,
} from '@/lib/pgprints'
import {
  API_FILE_MIME, apiFileFormatOf, isPgprintsSupplier, parseShipCountries,
  type PreviewFile, type PreviewIssue, type PreviewLine, type PushPreview, type PushStatus, type PushView,
} from '@/lib/pgprints-shared'

const ACTIVE_STATUSES: PushStatus[] = ['SENDING', 'CREATED']
const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
const EXPORT_READY = ['READY_TO_PRODUCTION', 'EXPORTED']
const UNKNOWN_RESULT_GRACE_MS = 2 * 60_000
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi PGprints đang hiệu lực — không gửi trùng'
export const TRACKING_RECEIVED = 'tracking-received'

export class PushError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly issues: PreviewIssue[] = []) {
    super(message)
    this.name = 'PushError'
  }
}

type PushRow = {
  id: string; orderId: string; supplierId: string; status: string; externalOrderId: string; supplierOrderCode: string | null
  supplierInternalId: string | null; remoteStatus: string | null; totalCost: number | null; shippingFee: number | null
  handleFee: number | null; error: string | null; pushedAt: Date; pushedById: string | null; cancelledAt: Date | null
  lastSyncedAt: Date | null; requestJson: string; exportMarked: boolean; prevExportJson: string | null
}

function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as string[]).includes(status)
}

function activeKeyFor(orderId: string, supplierId: string): string {
  return `${orderId}::${supplierId}`
}

function httpsUrl(v: string | null | undefined): string | null {
  if (!v) return null
  try { return new URL(v).protocol === 'https:' ? v : null } catch { return null }
}

export function hashPayload(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

export async function findPgprintsSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isPgprintsSupplier)
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

export type BuiltPush = { preview: PushPreview; rawBody: string | null; externalOrderId: string; supplierId: string | null }

export async function buildPush(orderId: string, opts: { withBalance?: boolean } = {}): Promise<BuiltPush | null> {
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

  const [settings, supplier] = await Promise.all([getPgprintsSettings(), findPgprintsSupplier()])
  const creds = credentialsOf(settings)
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const active = pushes.find(p => isActive(p.status)) ?? null
  const cancelledCount = pushes.filter(p => p.status === 'CANCELLED').length
  // A cancelled PGprints order keeps its order_id on their side, so a re-send after a cancel needs a fresh one.
  const externalOrderId = cancelledCount > 0 ? `${orderNo}-R${cancelledCount + 1}` : orderNo

  if (!supplier) error('NO_SUPPLIER', 'Chưa có xưởng mã "pgprints" trong danh sách xưởng')
  if (CLOSED_PIPELINE.includes(order.pipelineStatus) || CLOSED_FINANCIAL.includes((order.financialStatus ?? '').toUpperCase())) {
    error('ORDER_CLOSED', 'Đơn đã huỷ hoặc đã hoàn tiền — không gửi sản xuất')
  } else if (!EXPORT_READY.includes(order.pipelineStatus)) {
    const label = STATUS_LABELS[order.pipelineStatus as PipelineStatus] ?? order.pipelineStatus
    warning('PIPELINE_STATUS', `Đơn đang ở trạng thái "${label}" — gửi xong đơn sẽ không tự chuyển sang Exported`)
  }
  if ((order.financialStatus ?? '').toUpperCase() === 'PARTIALLY_REFUNDED') warning('PARTIAL_REFUND', 'Đơn đã hoàn tiền một phần — kiểm tra lại các dòng trước khi gửi')
  if (active) error('ACTIVE_PUSH', `Đơn đã được gửi sang PGprints${active.supplierOrderCode ? ` (mã ${active.supplierOrderCode})` : ''}`)
  const taken = await prisma.supplierOrderPush.findUnique({ where: { externalOrderId }, select: { orderId: true } })
  if (taken && taken.orderId !== orderId) error('ORDER_ID_TAKEN', `Mã đơn ${externalOrderId} đã được dùng cho một đơn khác đã gửi xưởng`)

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
  if (unmapped.length > 0) {
    error('UNMAPPED_LINE', `Dòng ${unmapped.map(l => taskKeyFor(order.shopifyOrderNumber, l.linePosition)).join(', ')} chưa map xưởng`)
  }
  if (supplier && foreign.length > 0) {
    const others = await prisma.supplier.findMany({ where: { id: { in: foreign.map(l => l.resolvedSupplierId as string) } }, select: { name: true } })
    error('MIXED_SUPPLIER', `Đơn có dòng thuộc xưởng khác (${others.map(s => s.name).join(', ') || 'không rõ'}) — bản này chỉ gửi được đơn mà mọi dòng đều của PGprints`)
  }
  const pushLines = supplier ? productLines.filter(l => l.resolvedSupplierId === supplier.id) : []

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, sku: { in: supplierSkus } }, select: { sku: true, apiSku: true, apiShipClass: true, apiShipCountries: true, apiFileFormat: true } })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  const lines: PreviewLine[] = []
  const lineItems: PgprintsLineItem[] = []
  const countryCode = countryCodeOf(order.shippingCountry)

  for (const l of pushLines) {
    const refId = taskKeyFor(order.shopifyOrderNumber, l.linePosition)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const wantedFormat = apiFileFormatOf(product)
    const wantedMime = API_FILE_MIME[wantedFormat]
    const template = await templateForLine(l)
    const slots = requiredSlotsFor(template)
    const lineFiles = order.artworks.filter(a => a.shopifyLineId === l.shopifyLineId)
    const prints = currentFiles(lineFiles, 'PRINT')
    // One file per print part in a fixed order: the template's areas, then every other part by name.
    const parts = [...slots, ...extraPrintParts(lineFiles, slots)]
    if (parts.length === 0) error('NO_ARTWORK', `${refId}: chưa có file in nào`, refId)
    const files: PreviewFile[] = []
    const fileUrls: string[] = []
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
      if (art.mimeType !== wantedMime) {
        if (art.mimeType === 'image/png' || art.mimeType === 'image/jpeg') {
          const got = art.mimeType === 'image/png' ? 'PNG' : 'JPG'
          warning('FILE_TYPE', `${refId}: file "${area}" là ${got} — SKU xưởng ${l.resolvedSupplierSku ?? '—'} yêu cầu ${wantedFormat} 300 DPI`, refId)
        } else {
          error('FILE_TYPE', `${refId}: file "${area}" (${art.fileName}) không phải ${wantedFormat} — xưởng không in được`, refId)
        }
      }
      const fit = slots.includes(area) ? printFileFit(template, area, art) : null
      const sizeOk = fit?.state === 'ok' ? true : fit?.state === 'bad' ? false : null
      if (!template) warning('NO_TEMPLATE', `${refId}: SKU xưởng chưa gán template in — không đối chiếu được kích thước file`, refId)
      else if (!target) warning('EXTRA_FILE', `${refId}: file "${area}" nằm ngoài các vùng in của template — vẫn gửi kèm cho xưởng`, refId)
      else if (sizeOk === null) warning('SIZE_UNKNOWN', `${refId}: không đọc được kích thước px của file "${area}"`, refId)
      else if (!sizeOk) warning('SIZE_MISMATCH', `${refId}: file "${area}" ${art.widthPx}×${art.heightPx}px khác khổ template ${target!.w}×${target!.h}px`, refId)
      let publicUrl: string | null = null
      if (baseUrl && approved) {
        publicUrl = publicArtworkUrl(baseUrl, await ensurePublicToken(art.id), art)
        fileUrls.push(publicUrl)
      }
      files.push({
        area, artworkId: art.id, fileName: art.fileName, mimeType: art.mimeType, widthPx: art.widthPx, heightPx: art.heightPx,
        expectedWidthPx: target?.w ?? null, expectedHeightPx: target?.h ?? null, sizeOk, publicUrl,
        viewUrl: artworkUrl(art.id), thumbUrl: art.previewPath ? `${artworkUrl(art.id)}?preview=1` : art.mimeType.startsWith('image/') && art.mimeType !== 'image/vnd.adobe.photoshop' ? artworkUrl(art.id) : null,
      })
    }

    const apiSku = product?.apiSku?.trim() || null
    if (!apiSku) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa có "SKU API" — điền ở trang cài đặt xưởng Pgprints`, refId)
    const productShipClass = product?.apiShipClass?.trim() || null
    const shipClass = productShipClass ?? settings.defaultShipClass
    if (!shipClass) error('NO_SHIP_CLASS', `${refId}: chưa có ship class (cột "Ship class" của SKU hoặc ship class mặc định)`, refId)
    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length > 0 && (!countryCode || !shipCountries.includes(countryCode))) {
      const destination = countryCode ?? (order.shippingCountry?.trim() || 'không rõ nước')
      error('SHIP_COUNTRY', `${refId}: SKU ${apiSku ?? l.resolvedSupplierSku ?? '—'} chỉ giao tới: ${shipCountries.join(', ')} — đơn này giao ${destination}`, refId)
    }
    if (l.qty <= 0) error('BAD_QUANTITY', `${refId}: số lượng phải lớn hơn 0`, refId)
    // Mockups the designer uploaded come first; without one the customer preview / product image is sent as before.
    const mockupFiles = currentFiles(lineFiles, 'MOCKUP')
      .filter(a => a.mimeType === 'image/png' || a.mimeType === 'image/jpeg')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const mockupImages: string[] = []
    if (baseUrl && approved) {
      for (const m of mockupFiles) {
        const url = httpsUrl(publicArtworkUrl(baseUrl, await ensurePublicToken(m.id), m))
        if (url) mockupImages.push(url)
      }
    }
    const fallbackMockup = httpsUrl(l.previewCdnUrl ?? l.imageUrl)
    if (mockupImages.length === 0 && fallbackMockup) mockupImages.push(fallbackMockup)
    const mockupUrl = mockupFiles[0] ? artworkUrl(mockupFiles[0].id) : fallbackMockup
    if (!mockupUrl) warning('NO_MOCKUP', `${refId}: không có ảnh mockup (https) để gửi kèm`, refId)
    const note = l.designNote?.trim() || null

    lines.push({
      refId, lineId: l.id, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku, shipClass: shipClass ?? null,
      shipClassSource: productShipClass ? 'product' : shipClass ? 'default' : null, shipCountries,
      templateName: template?.name ?? null, mockupUrl, designNote: note, files,
    })
    lineItems.push({
      name: l.variantTitle ? `${l.productTitle} - ${l.variantTitle}` : l.productTitle,
      refId, quantity: l.qty, sku: apiSku ?? '', shipClass: shipClass ?? '',
      fileUrls, mockupImages,
    })
  }

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const fullName = (order.shippingName ?? order.customerName ?? '').trim()
  const shipName = splitPersonName(fullName)
  const customerName = splitPersonName(order.customerName ?? fullName)
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
  if (!stateCode) {
    if (countryCode === 'US') error('ADDRESS_STATE', `Thiếu mã bang 2 chữ cho đơn Mỹ (bang: "${order.shippingState ?? ''}")`)
    else if (countryCode === 'CA') warning('ADDRESS_STATE', `Không xác định được mã tỉnh bang Canada từ "${order.shippingState ?? ''}"`)
  }
  if (!phone) warning('ADDRESS_PHONE', 'Thiếu số điện thoại người nhận')
  const addressLines = splitAddressLine(order.shippingAddress1 ?? '', order.shippingAddress2 ?? '')
  if (addressLines.split) warning('ADDRESS_SPLIT', `Địa chỉ dòng 1 dài hơn ${PGPRINTS_ADDRESS_LINE_MAX} ký tự (giới hạn PGprints) — gửi "${addressLines.address1}" và chuyển phần còn lại xuống dòng 2: "${addressLines.address2}"`)
  if (!email) warning('ADDRESS_EMAIL', 'Thiếu email khách hàng')

  let payload: PgprintsOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    payload = {
      order_id: externalOrderId,
      email,
      shipping_address: {
        first_name: shipName.first, last_name: shipName.last, name: fullName, email, phone,
        address1: addressLines.address1, address2: addressLines.address2, company: '',
        city: order.shippingCity?.trim() ?? '', zip: order.shippingZip?.trim() ?? '',
        province: order.shippingState?.trim() ?? '', province_code: stateCode ?? '',
        country: countryCode ? countryNameOf(countryCode) : (order.shippingCountry ?? ''), country_code: countryCode ?? '',
      },
      customer: { first_name: customerName.first, last_name: customerName.last },
      line_items: lineItems,
      response_type: 'normal',
    }
  }
  const rawBody = payload ? serializeOrderPayload(payload) : null

  let balance: PushPreview['balance'] = null
  if (opts.withBalance && creds) {
    try {
      balance = await getBalance(creds)
    } catch (e: any) {
      warning('BALANCE', `Không lấy được số dư PGprints: ${e?.message ?? e}`)
    }
  }

  const views = await toPushViews(pushes)
  const hasErrors = issues.some(i => i.level === 'error')
  return {
    rawBody,
    externalOrderId,
    supplierId: supplier?.id ?? null,
    preview: {
      order: {
        id: order.id, shopifyOrderNumber: order.shopifyOrderNumber, pipelineStatus: order.pipelineStatus,
        storeName: order.store.project?.name ?? order.store.shop,
      },
      supplier,
      pushEnabled: settings.pushEnabled,
      hasCredentials: !!creds,
      canPush: !!payload && !hasErrors && settings.pushEnabled && !!creds,
      payload,
      payloadHash: rawBody ? hashPayload(rawBody) : null,
      lines,
      issues,
      balance,
      activePush: views.find(v => isActive(v.status)) ?? null,
      history: views,
    },
  }
}

function isUniqueViolation(e: any): boolean {
  if (e?.code === 'P2002') return true
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  return msg.includes('UNIQUE constraint failed') || msg.includes('Unique constraint failed')
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
        // PGprints never accepted this order_id, so the retry reuses it: their uniqueness check then also covers a create that failed after it had landed.
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

export async function pushOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const settings = await getPgprintsSettings()
  if (!settings.pushEnabled) throw new PushError('Chưa bật gửi đơn sang PGprints — bật ở trang cài đặt xưởng Pgprints', 403, 'PUSH_DISABLED')
  const creds = credentialsOf(settings)
  if (!creds) throw new PushError('Chưa cấu hình Store ID / Secret key PGprints', 400, 'NO_CREDENTIALS')

  const built = await buildPush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi PGprints', 422, 'NOT_ELIGIBLE', errors)
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
    if (e instanceof PgprintsError && e.noResponse) {
      // No answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
      const text = `${message}. Chưa rõ PGprints đã nhận đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`
      await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text } })
      throw new PushError(text, 504, 'UNKNOWN_RESULT')
    }
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: {
        status: 'FAILED', activeKey: null, error: message,
        responseJson: e instanceof PgprintsError && e.body != null ? JSON.stringify(e.body).slice(0, 20_000) : null,
      },
    })
    throw new PushError(`PGprints từ chối đơn: ${message}`, 502, 'CREATE_FAILED')
  }

  await prisma.supplierOrderPush.update({
    where: { id: reserved.id },
    data: {
      status: 'CREATED', error: null,
      supplierOrderCode: created.order.pgcOrderId, supplierInternalId: created.order.id,
      totalCost: created.order.totalCost, shippingFee: created.order.shippingFee, handleFee: created.order.handleFee,
      responseJson: JSON.stringify(created.raw).slice(0, 200_000),
    },
  })
  const exported = await markPushExported({ id: reserved.id, orderId, supplierId: built.supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
  if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (PGprints) — mã ${created.order.pgcOrderId ?? built.externalOrderId}`, input.userId)
  return { push: await viewOf(reserved.id), exported }
}

async function latestPush(orderId: string, statuses: PushStatus[]): Promise<PushRow | null> {
  return prisma.supplierOrderPush.findFirst({ where: { orderId, status: { in: statuses } }, orderBy: { createdAt: 'desc' } })
}

export async function cancelPush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const push = await latestPush(orderId, ['SENDING', 'CREATED'])
  if (!push) throw new PushError('Đơn không có lần gửi PGprints nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') {
    throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  }
  const creds = credentialsOf(await getPgprintsSettings())
  if (!creds) throw new PushError('Chưa cấu hình Store ID / Secret key PGprints', 400, 'NO_CREDENTIALS')
  try {
    await cancelOrder(creds, push.supplierOrderCode ?? push.externalOrderId)
  } catch (e: any) {
    throw new PushError(`PGprints không huỷ được đơn: ${e?.message ?? e}`, e instanceof PgprintsError && e.noResponse ? 504 : 502, 'CANCEL_FAILED')
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
    // Touch the order only while it still carries exactly the marking this push wrote.
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
    // Only the lines this push marked carry its supplier and its pushedAt; lines sent another way keep their mark.
    // An order re-marked Exported after the push keeps its lines too, or it would be Exported with unsent lines.
    const stillExported = reverted.count === 0
      && (await prisma.order.count({ where: { id: orderId, pipelineStatus: 'EXPORTED' } })) > 0
    const lines = stillExported ? { count: 0 } : await prisma.orderLine.updateMany({
      where: { orderId, exportedToSupplierId: push.supplierId, exportedAt: push.pushedAt },
      data: { exportedAt: null, exportedToSupplierId: null },
    })
    exportReverted = reverted.count === 1 || lines.count > 0
    if (exportReverted) await logHandoffEvent(orderId, 'Huỷ đơn bên PGprints — đơn trở lại chờ chuyển xưởng', null)
  }
  return { push: await viewOf(push.id), exportReverted }
}

type TrackingItem = { sku: string | null; trackingNumber: string | null; carrierCode: string | null }

async function upsertSupplierTracking(push: Pick<PushRow, 'orderId' | 'supplierId' | 'requestJson'>, items: TrackingItem[]): Promise<number> {
  const tracked = items.filter(i => !!i.trackingNumber)
  if (tracked.length === 0) return 0
  const order = await prisma.order.findUnique({
    where: { id: push.orderId },
    select: {
      id: true, projectId: true, shopifyOrderNumber: true,
      lines: { orderBy: { linePosition: 'asc' }, select: { shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true } },
    },
  })
  if (!order) return 0
  let sent: { refId?: string; sku?: string }[] = []
  try {
    const parsed = JSON.parse(push.requestJson)
    if (Array.isArray(parsed?.line_items)) sent = parsed.line_items
  } catch {}
  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  // Shipment.lineKey numbers product lines only (see buildOrderShipments), unlike refId which carries linePosition.
  const productLines = order.lines.filter(l => !isNonProductLine(l))
  let touched = 0
  for (const item of tracked) {
    const refs = sent.filter(li => typeof li.refId === 'string' && (!item.sku || li.sku === item.sku))
    for (const ref of refs) {
      const position = Number(String(ref.refId).split('_').pop())
      const index = productLines.findIndex(l => l.linePosition === position)
      if (index < 0) continue
      const line = productLines[index]
      const lineKey = `${orderNo}_${index + 1}`
      const existing = await prisma.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } } })
      if (!existing) {
        await prisma.shipment.create({
          data: {
            orderId: order.id, projectId: order.projectId, lineKey, shopifyLineId: line.shopifyLineId, sku: line.sku, productTitle: line.productTitle,
            supplierId: push.supplierId, trackingNumber: item.trackingNumber, carrier: item.carrierCode, status: SHIPMENT_STATUS_FULFILLED,
          },
        })
        touched++
        continue
      }
      // Shopify's own fulfillment is what the customer sees; a supplier webhook never overrides it.
      if (existing.shopifyFulfillmentId && existing.trackingNumber) continue
      await prisma.shipment.update({
        where: { id: existing.id },
        data: {
          // The line shipped from the pushed supplier even when the order sync first mapped it elsewhere (Mangoshao → PGprints moves).
          trackingNumber: item.trackingNumber, carrier: item.carrierCode ?? existing.carrier, supplierId: push.supplierId,
          ...(existing.status === SHIPMENT_STATUS_PENDING ? { status: SHIPMENT_STATUS_FULFILLED } : {}),
        },
      })
      touched++
    }
  }
  return touched
}

function remoteStatusOf(o: PgprintsRemoteOrder): string | null {
  const statuses = o.itemStatuses.length > 0 ? o.itemStatuses : o.items.map(i => i.status).filter((s): s is string => !!s)
  const unique = Array.from(new Set(statuses))
  return unique.length > 0 ? unique.join(', ') : null
}

export async function refreshPush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const push = (await latestPush(orderId, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, ['CANCELLED', 'FAILED']))
  if (!push) throw new PushError('Đơn chưa từng gửi PGprints', 404, 'NOT_FOUND')
  const creds = credentialsOf(await getPgprintsSettings())
  if (!creds) throw new PushError('Chưa cấu hình Store ID / Secret key PGprints', 400, 'NO_CREDENTIALS')
  const now = Date.now()
  let remote: PgprintsRemoteOrder[]
  try {
    remote = await searchOrders(creds, {
      fromTime: push.pushedAt.getTime() - 24 * 3600_000, toTime: now + 3600_000,
      searchKey: push.supplierOrderCode ?? push.externalOrderId, page: 1, size: 20,
    })
  } catch (e: any) {
    throw new PushError(`Không lấy được trạng thái từ PGprints: ${e?.message ?? e}`, e instanceof PgprintsError && e.noResponse ? 504 : 502, 'REFRESH_FAILED')
  }
  const match = remote.find(o => o.orderId === push.externalOrderId || (!!push.supplierOrderCode && o.pgcOrderId === push.supplierOrderCode)) ?? null
  const lastSyncedAt = new Date(now)
  if (!match) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: stale
        ? { status: 'FAILED', activeKey: null, lastSyncedAt, error: 'PGprints không có đơn này — lần gửi không thành công, có thể gửi lại' }
        : { lastSyncedAt },
    })
    return { push: await viewOf(push.id), found: false, shipments: 0 }
  }
  const shipments = await applyRemoteMatch(push, match, lastSyncedAt)
  return { push: await viewOf(push.id), found: true, shipments }
}

async function applyRemoteMatch(push: PushRow, match: PgprintsRemoteOrder, lastSyncedAt: Date): Promise<number> {
  // PGprints holds an order under our order_id, so a push we recorded as unanswered or refused did land after all.
  const landed = push.status === 'SENDING' || push.status === 'FAILED'
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remoteStatusOf(match),
        supplierOrderCode: push.supplierOrderCode ?? match.pgcOrderId, supplierInternalId: push.supplierInternalId ?? match.id,
        totalCost: match.totalCost ?? push.totalCost, shippingFee: match.shippingFee ?? push.shippingFee, handleFee: match.handleFee ?? push.handleFee,
        ...(landed ? { status: 'CREATED', error: null, activeKey: activeKeyFor(push.orderId, push.supplierId) } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  return push.status === 'CANCELLED' ? 0 : upsertSupplierTracking(push, match.items)
}

const SYNC_PAGE_SIZE = 50
const SYNC_MAX_PAGES = 40

// Pulls every live PGprints push's status + tracking in a few paged searches (one window from
// the oldest live push), instead of one request per order. Tracking lands on Shipment rows;
// Auto Fulfill turns those into Shopify fulfillments.
export async function syncPgprintsTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findPgprintsSupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no PGprints supplier' }
  const creds = credentialsOf(await getPgprintsSettings())
  if (!creds) return { pushes: 0, found: 0, shipments: 0, skipped: 'no PGprints credentials' }
  const pushes = await prisma.supplierOrderPush.findMany({ where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES } } })
  if (pushes.length === 0) return { pushes: 0, found: 0, shipments: 0 }
  const now = Date.now()
  const fromTime = Math.min(...pushes.map(p => p.pushedAt.getTime())) - 24 * 3600_000
  const remote: PgprintsRemoteOrder[] = []
  for (let page = 1; page <= SYNC_MAX_PAGES; page++) {
    const batch = await searchOrders(creds, { fromTime, toTime: now + 3600_000, page, size: SYNC_PAGE_SIZE })
    remote.push(...batch)
    if (batch.length < SYNC_PAGE_SIZE) break
  }
  const lastSyncedAt = new Date(now)
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    const match = remote.find(o => o.orderId === push.externalOrderId || (!!push.supplierOrderCode && o.pgcOrderId === push.supplierOrderCode))
    if (!match) continue
    found++
    try { shipments += await applyRemoteMatch(push, match, lastSyncedAt) }
    catch (e: any) { console.error('[pgprints] tracking sync failed for push', push.id, e?.message ?? e) }
  }
  return { pushes: pushes.length, found, shipments }
}

export type TrackingWebhookInput = {
  orderId?: unknown; pgcOrderId?: unknown; sku?: unknown; trackingNumber?: unknown; carrierCode?: unknown; storeId?: unknown
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export async function applyTrackingWebhook(input: TrackingWebhookInput): Promise<{ ignored: boolean; reason?: string; shipments: number }> {
  const ids = Array.from(new Set([text(input.orderId), text(input.pgcOrderId)].filter((x): x is string => !!x)))
  if (ids.length === 0) return { ignored: true, reason: 'missing order id', shipments: 0 }
  const push = await prisma.supplierOrderPush.findFirst({
    where: { status: { in: ACTIVE_STATUSES }, OR: [{ externalOrderId: { in: ids } }, { supplierOrderCode: { in: ids } }] },
    orderBy: { createdAt: 'desc' },
  })
  if (!push) return { ignored: true, reason: 'unknown order', shipments: 0 }
  const trackingNumber = text(input.trackingNumber)
  if (!trackingNumber) return { ignored: true, reason: 'missing tracking number', shipments: 0 }
  const shipments = await upsertSupplierTracking(push, [{ sku: text(input.sku), trackingNumber, carrierCode: text(input.carrierCode) }])
  await prisma.supplierOrderPush.update({
    where: { id: push.id },
    data: {
      remoteStatus: TRACKING_RECEIVED, lastSyncedAt: new Date(),
      ...(push.status === 'SENDING' ? { status: 'CREATED', error: null, supplierOrderCode: push.supplierOrderCode ?? text(input.pgcOrderId) } : {}),
    },
  })
  if (push.status === 'SENDING') await markPushExported(push)
  return { ignored: false, shipments }
}

export type OrderPgprintsFlag = { candidate: boolean; push: { status: PushStatus; supplierOrderCode: string | null } | null }

/** Cheap per-row hint for order lists: is this a pure-PGprints order, and has it been sent. Full eligibility lives in buildPush. */
export async function pgprintsFlagsForOrders(orders: Array<{
  id: string; pipelineStatus: string
  lines: Array<{ sku: string | null; productTitle: string; shopifyProductType: string | null; resolvedSupplierId: string | null }>
}>): Promise<Map<string, OrderPgprintsFlag>> {
  const out = new Map<string, OrderPgprintsFlag>()
  const supplier = orders.length > 0 ? await findPgprintsSupplier() : null
  if (!supplier) return out
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { orderId: { in: orders.map(o => o.id) }, supplierId: supplier.id },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, status: true, supplierOrderCode: true },
  })
  for (const o of orders) {
    const productLines = o.lines.filter(l => !isNonProductLine(l))
    const candidate = productLines.length > 0 && productLines.every(l => l.resolvedSupplierId === supplier.id) && !CLOSED_PIPELINE.includes(o.pipelineStatus)
    const mine = pushes.filter(p => p.orderId === o.id)
    const shown = mine.find(p => isActive(p.status)) ?? mine[0] ?? null
    if (!candidate && !shown) continue
    out.set(o.id, { candidate, push: shown ? { status: shown.status as PushStatus, supplierOrderCode: shown.supplierOrderCode } : null })
  }
  return out
}
