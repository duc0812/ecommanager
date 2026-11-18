import { prisma } from '@/lib/db'
import { DROPSHIP_PUSH_REFUSAL } from '@/lib/dropship'
import { logHandoffEvent, markPushExported, nextExternalOrderId, planPushLines } from '@/lib/repos/push-export'
import { countryCodeOf, resolveStateCode } from '@/lib/shipping-address'
import { isNonProductLine } from '@/lib/order-lines'
import { isLineApproved } from '@/lib/public-artwork'
import { PushError, hashPayload } from '@/lib/repos/pgprints-push'
import {
  ACTIVE_STATUSES, CLOSED_PIPELINE, UNKNOWN_RESULT_GRACE_MS, activeKeyFor, checkOrderForPush, closeCancelledPush, collectLineFiles,
  isActive, isUniqueViolation, latestPush, loadOrderForPush, reservePush, toPushViews, upsertLineTracking, viewOf, type PushRow,
} from '@/lib/repos/supplier-push-core'
import {
  CKF_UNPAID_LABEL, CatkissfishError, cancelOrder, createAutoDesignOrder, createdOrderOf, designListFor, findOrder, formatAccepted, getOrder, getProductDetail,
  getTrackingNumbers, hasLeftFactory, isCatkissfishSupplier, isClosedState, phoneParts, pickVariant, shippingOf, singleTracking, styleCodeOf,
  type CatkissfishSession, type CkfDesignInfo, type CkfOrderPayload, type CkfProduct, type CkfRemoteOrder,
} from '@/lib/catkissfish'
import { CKF_AUTO_SHIPPING } from '@/lib/catkissfish-shipping'
import { catkissfishSession, getCatkissfishSettings, hasCatkissfishAccount, type CatkissfishSettings } from '@/lib/catkissfish-settings'
import { parseShipCountries, type PreviewIssue, type PreviewLine, type PushPreview, type PushView } from '@/lib/pgprints-shared'

const NAME = 'CatKissFish'
const DUPLICATE_MESSAGE = 'Đơn này đã có một lần gửi CatKissFish đang hiệu lực — không gửi trùng'
const NO_ACCOUNT_MESSAGE = 'Chưa lưu client_id / client_secret CatKissFish ở Setup › Fulfill'
const TRACKING_WINDOW_DAYS = 90

export async function findCatkissfishSupplier(): Promise<{ id: string; name: string; code: string } | null> {
  const all = await prisma.supplier.findMany({ select: { id: true, name: true, code: true, apiType: true, isActive: true } })
  const hits = all.filter(isCatkissfishSupplier)
  const pick = hits.find(s => s.isActive) ?? hits[0]
  return pick ? { id: pick.id, name: pick.name, code: pick.code } : null
}

async function sessionOrThrow(): Promise<CatkissfishSession> {
  const settings = await getCatkissfishSettings()
  if (!hasCatkissfishAccount(settings)) throw new PushError(NO_ACCOUNT_MESSAGE, 400, 'NO_CREDENTIALS')
  return catkissfishSession(settings)
}

type ProductRow = {
  sku: string; apiSku: string | null; apiShipClass: string | null; apiShipCountries: string | null
  variant1Name: string | null; variant1Value: string | null; variant2Name: string | null; variant2Value: string | null
}

/** The blank's color and size on the supplier SKU, whichever variant column holds which. */
function blankOf(p: ProductRow | undefined): { color: string | null; size: string | null } {
  if (!p) return { color: null, size: null }
  const isColor = (name: string | null) => /colou?r|màu/i.test(name ?? '')
  return isColor(p.variant1Name) && !isColor(p.variant2Name)
    ? { color: p.variant1Value, size: p.variant2Value }
    : { color: p.variant2Value, size: p.variant1Value }
}

function shippingFor(product: ProductRow | undefined, settings: CatkissfishSettings, countryCode: string | null) {
  const own = product?.apiShipClass?.trim()
  const wanted = own || (countryCode === 'US' ? settings.shippingId : settings.shippingIdIntl)
  const method = wanted?.toUpperCase() === CKF_AUTO_SHIPPING ? { id: CKF_AUTO_SHIPPING, name: 'CatKissFish tự chọn' } : shippingOf(wanted)
  return { method, source: own ? 'product' as const : 'default' as const, wanted }
}

export type BuiltCatkissfishPush = { preview: PushPreview; rawBody: string | null; externalOrderId: string; supplierId: string | null }

export async function buildCatkissfishPush(orderId: string): Promise<BuiltCatkissfishPush | null> {
  const order = await loadOrderForPush(orderId)
  if (!order) return null

  const settings = await getCatkissfishSettings()
  const hasAccount = hasCatkissfishAccount(settings)
  const supplier = await findCatkissfishSupplier()
  const issues: PreviewIssue[] = []
  const error = (code: string, message: string, refId?: string) => { issues.push({ level: 'error', code, message, refId }) }
  const warning = (code: string, message: string, refId?: string) => { issues.push({ level: 'warning', code, message, refId }) }
  // A scarf file off the template size prints wrong and CatKissFish lays it out from what we upload, so it stops the send.
  const fileReport = { error, warning: (code: string, message: string, refId?: string) => (code === 'SIZE_MISMATCH' ? error : warning)(code, message, refId) }

  const orderNo = order.shopifyOrderNumber.replace(/^#/, '')
  const pushes: PushRow[] = supplier
    ? await prisma.supplierOrderPush.findMany({ where: { orderId, supplierId: supplier.id }, orderBy: { createdAt: 'desc' } })
    : []
  const own = order.lines.filter(l => !isNonProductLine(l) && !!supplier && l.resolvedSupplierId === supplier.id)
  const plan = planPushLines(order, own.filter(l => !l.dropship), pushes)
  const active = plan.later ? null : pushes.find(p => isActive(p.status)) ?? null
  const externalOrderId = await nextExternalOrderId(orderNo, { orderId, supplierId: supplier?.id ?? null, later: plan.later })
  const pushLines = plan.lines

  if (!hasAccount) error('NO_CREDENTIALS', NO_ACCOUNT_MESSAGE)
  const { baseUrl, keyOf } = await checkOrderForPush(order, supplier, { name: NAME, active, externalOrderId, lines: pushLines, held: plan.held }, { error, warning })
  for (const l of own) if (l.dropship && !l.exportedAt) warning('DROPSHIP', `${keyOf(l)}: ${DROPSHIP_PUSH_REFUSAL} — dòng này không gửi qua API`, keyOf(l))

  const supplierSkus = Array.from(new Set(pushLines.map(l => l.resolvedSupplierSku).filter((x): x is string => !!x)))
  const products: ProductRow[] = supplier && supplierSkus.length
    ? await prisma.supplierProduct.findMany({
        where: { supplierId: supplier.id, sku: { in: supplierSkus } },
        select: { sku: true, apiSku: true, apiShipClass: true, apiShipCountries: true, variant1Name: true, variant1Value: true, variant2Name: true, variant2Value: true },
      })
    : []
  const productBySku = new Map(products.map(p => [p.sku, p]))

  // Colors, sizes and design areas are CatKissFish's own, so a send is built from what it says today.
  const details = new Map<string, CkfProduct>()
  if (hasAccount && !active) {
    const session = catkissfishSession(settings)
    const styles = Array.from(new Set(products.map(styleCodeOf).filter((s): s is string => !!s)))
    for (const style of styles) {
      try {
        const detail = await getProductDetail(session, style)
        if (detail) details.set(style, detail)
        else error('CKF_PRODUCT', `CatKissFish không có style "${style}"`)
      } catch (e: any) {
        error('CKF_PRODUCT', `Không đọc được style "${style}" từ CatKissFish: ${e?.message ?? e}`)
      }
    }
  }

  const countryCode = countryCodeOf(order.shippingCountry)
  const lines: PreviewLine[] = []
  const designInfos: CkfDesignInfo[] = []
  const carriers = new Map<string, string>()

  for (const l of pushLines) {
    const refId = keyOf(l)
    const task = order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId) ?? null
    const approved = isLineApproved(l, task)
    if (!approved) error('NOT_APPROVED', `${refId}: thiết kế chưa được duyệt (task phải ở trạng thái Xong)`, refId)

    const product = l.resolvedSupplierSku ? productBySku.get(l.resolvedSupplierSku) : undefined
    const styleCode = product ? styleCodeOf(product) : null
    if (!styleCode) error('NO_API_SKU', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa có style code CatKissFish — điền cột SKU API của SKU này`, refId)
    const detail = styleCode ? details.get(styleCode) ?? null : null

    const shipping = shippingFor(product, settings, countryCode)
    if (shipping.method) carriers.set(shipping.method.id, shipping.method.name)
    else if (shipping.wanted) error('SHIP_METHOD', `${refId}: CatKissFish không có cách ship "${shipping.wanted}"`, refId)
    else error('SHIP_METHOD', `${refId}: đơn giao ${countryCode ?? 'ngoài Mỹ'} chưa có cách ship — chọn "Cách ship đơn ngoài Mỹ" ở Setup › Fulfill`, refId)

    const shipCountries = parseShipCountries(product?.apiShipCountries)
    if (shipCountries.length > 0 && (!countryCode || !shipCountries.includes(countryCode))) {
      error('SHIP_COUNTRY', `${refId}: SKU ${l.resolvedSupplierSku ?? '—'} chỉ giao tới: ${shipCountries.join(', ')} — đơn này giao ${countryCode ?? order.shippingCountry ?? 'không rõ'}`, refId)
    }

    const found = await collectLineFiles(l, order.artworks, { refId, approved, baseUrl, supplierName: NAME }, fileReport)
    if (!found.image) error('NO_MOCKUP', `${refId}: CatKissFish bắt buộc có ảnh mockup (https) — dòng này không có`, refId)
    if (l.qty <= 0) error('BAD_QUANTITY', `${refId}: số lượng phải lớn hơn 0`, refId)
    // The note on a line is the CS team's own; it stays out of what the factory receives.
    const note = l.designNote?.trim() || null
    if (note) warning('DESIGN_NOTE', `${refId}: có ghi chú sản xuất — ghi chú nội bộ không gửi sang CatKissFish, báo xưởng riêng nếu cần`, refId)

    const variant = pickVariant(detail, blankOf(product))
    if (variant.problem) error('CKF_VARIANT', `${refId}: ${variant.problem}`, refId)
    else if (!variant.color || !variant.size) error('CKF_VARIANT', `${refId}: SKU xưởng ${l.resolvedSupplierSku ?? '—'} chưa có màu hoặc size phôi`, refId)

    const design = designListFor(found.prints, detail?.dimensions ?? [])
    if (design.unmatched.length > 0) error('CKF_AREA', `${refId}: CatKissFish không có vùng in cho file: ${design.unmatched.join(', ')}`, refId)
    if (design.unfilled.length > 0) warning('CKF_AREA_EMPTY', `${refId}: vùng in chưa có file: ${design.unfilled.join(', ')}`, refId)
    for (const f of found.files) {
      if (!formatAccepted(design.dimensionOf.get(f.area), f.mimeType)) warning('CKF_FILE_FORMAT', `${refId}: vùng "${f.area}" của CatKissFish không ghi nhận định dạng ${f.mimeType}`, refId)
    }

    lines.push({
      refId, lineId: l.id, shopifyLineId: l.shopifyLineId, linePosition: l.linePosition, productTitle: l.productTitle, variantTitle: l.variantTitle, quantity: l.qty,
      supplierSku: l.resolvedSupplierSku, apiSku: styleCode, shipClass: shipping.method?.name ?? null, shipClassSource: shipping.source,
      shipCountries, templateName: found.templateName, mockupUrl: found.mockupUrl, designNote: note, files: found.files,
    })
    designInfos.push({
      styleCode: styleCode ?? '', customSku: refId, customerSku: refId, color: variant.color ?? '', size: variant.size ?? '', quantity: l.qty,
      mockupList: found.image ? [{ imageUrl: found.image }] : [], designList: design.list,
    })
  }
  if (carriers.size > 1) error('SHIP_METHOD_MIXED', `Các dòng của đơn này khác cách ship (${Array.from(carriers.values()).join(', ')}) — một đơn CatKissFish chỉ đi một cách`)

  const stateCode = resolveStateCode({ countryCode, stateCode: order.shippingStateCode, state: order.shippingState })
  const userName = (order.shippingName ?? order.customerName ?? '').trim()
  const city = order.shippingCity?.trim() ?? ''
  const postalCode = order.shippingZip?.trim() ?? ''
  const detailAddress = [order.shippingAddress1, order.shippingAddress2].map(s => s?.trim()).filter(Boolean).join(', ')
  const province = stateCode ?? (order.shippingState?.trim() || city)
  const phone = phoneParts(order.shippingPhone, countryCode)
  // As with Printway, the shopper's email goes only on orders outside the US, where a carrier may need it.
  const email = countryCode && countryCode !== 'US' ? order.customerEmail?.trim() ?? '' : ''
  if (!userName) error('ADDRESS_NAME', 'Thiếu tên người nhận')
  if (!detailAddress) error('ADDRESS_LINE', 'Thiếu địa chỉ giao hàng')
  if (!city) error('ADDRESS_CITY', 'Thiếu thành phố giao hàng')
  if (!countryCode) error('ADDRESS_COUNTRY', `Không xác định được mã quốc gia từ "${order.shippingCountry ?? ''}"`)
  if (!postalCode) error('ADDRESS_ZIP', 'Thiếu mã bưu chính (zip) — CatKissFish bắt buộc')
  if (!stateCode && countryCode === 'US') error('ADDRESS_STATE', `Thiếu mã bang 2 chữ cho đơn Mỹ (bang: "${order.shippingState ?? ''}")`)
  else if (!province) error('ADDRESS_STATE', 'Thiếu tỉnh/bang — CatKissFish bắt buộc')
  else if (!stateCode && !order.shippingState?.trim()) warning('ADDRESS_STATE', `Đơn không có tỉnh/bang — gửi thành phố "${city}" vào ô tỉnh`)
  if (!phone.phone) warning('ADDRESS_PHONE', 'Thiếu số điện thoại người nhận')

  let payload: CkfOrderPayload | null = null
  if (supplier && baseUrl && pushLines.length > 0) {
    const carrier = Array.from(carriers.keys())[0] ?? ''
    payload = {
      platformOrderId: externalOrderId,
      ...(carrier === CKF_AUTO_SHIPPING ? {} : { shippingId: carrier }),
      designInfos,
      shippingAddress: {
        userName, country: countryCode ?? '', countryAbbreviation: countryCode ?? '', province, city, detailAddress, postalCode,
        ...(email ? { email } : {}), ...phone,
      },
    }
  }
  const rawBody = payload ? JSON.stringify(payload) : null
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
      pushEnabled: hasAccount,
      hasCredentials: hasAccount,
      canPush: !!payload && !hasErrors && hasAccount,
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

async function recordLanded(pushId: string, remote: CkfRemoteOrder | null, response: unknown) {
  await prisma.supplierOrderPush.update({
    where: { id: pushId },
    data: {
      status: 'CREATED', error: null, supplierOrderCode: remote?.id ?? null, remoteStatus: remote?.stateLabel ?? null,
      responseJson: JSON.stringify(response ?? null).slice(0, 200_000),
    },
  })
}

export async function pushCatkissfishOrder(orderId: string, input: { payloadHash: string; userId: string | null }): Promise<{ push: PushView; exported: boolean }> {
  const session = await sessionOrThrow()
  const built = await buildCatkissfishPush(orderId)
  if (!built) throw new PushError('Không tìm thấy đơn', 404, 'NOT_FOUND')
  if (built.preview.activePush && !built.preview.laterSend) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
  const errors = built.preview.issues.filter(i => i.level === 'error')
  if (errors.length > 0 || !built.rawBody || !built.preview.payloadHash || !built.supplierId) {
    throw new PushError(errors[0]?.message ?? 'Đơn chưa đủ điều kiện gửi CatKissFish', 422, 'NOT_ELIGIBLE', errors)
  }
  if (built.preview.payloadHash !== input.payloadHash) {
    throw new PushError('Nội dung đơn đã thay đổi sau khi xem trước — mở lại bản xem trước rồi xác nhận', 409, 'PAYLOAD_CHANGED')
  }
  const supplierId = built.supplierId

  const reserved = await reservePush({
    orderId, supplierId, externalOrderId: built.externalOrderId, lines: built.preview.lines.map(l => ({ id: l.lineId, shopifyLineId: l.shopifyLineId })), requestJson: built.rawBody, userId: input.userId,
  }, DUPLICATE_MESSAGE)

  const refuse = async (message: string, body: unknown) => {
    await prisma.supplierOrderPush.update({
      where: { id: reserved.id },
      data: { status: 'FAILED', activeKey: null, error: message, responseJson: body != null ? JSON.stringify(body).slice(0, 20_000) : null },
    })
  }
  const finish = async (remote: CkfRemoteOrder | null, response: unknown) => {
    await recordLanded(reserved.id, remote, response)
    const exported = await markPushExported({ id: reserved.id, orderId, supplierId, pushedAt: reserved.pushedAt, pushedById: input.userId })
    if (exported) await logHandoffEvent(orderId, `Chuyển supplier qua API (CatKissFish) — mã ${remote?.id ?? built.externalOrderId}`, input.userId)
    return { push: await viewOf(reserved.id), exported }
  }

  // The docs promise no duplicate check on platformOrderId, so the tool looks first: nothing has been sent yet if this fails.
  let existing: CkfRemoteOrder | null
  try {
    existing = await findOrder(session, built.externalOrderId)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    await refuse(`Chưa gửi: không kiểm tra được đơn trùng trên CatKissFish (${message})`, e instanceof CatkissfishError ? e.body : null)
    throw new PushError(`Chưa gửi đơn: không kiểm tra được đơn trùng trên CatKissFish (${message})`, e instanceof CatkissfishError && e.unknownOutcome ? 504 : 502, 'CHECK_FAILED')
  }
  if (existing && !isClosedState(existing.state)) return finish(existing, { foundBeforeCreate: existing })

  let response: unknown
  try {
    response = await createAutoDesignOrder(session, built.rawBody)
  } catch (e: any) {
    const message = e?.message ?? String(e)
    if (e instanceof CatkissfishError && e.unknownOutcome) {
      // No clear answer is not a refusal: the order may exist on their side, so the push stays live and blocks a blind re-send.
      const text = `${message}. Chưa rõ CatKissFish đã nhận đơn hay chưa — bấm "Cập nhật trạng thái" để kiểm tra trước khi gửi lại`
      await prisma.supplierOrderPush.update({ where: { id: reserved.id }, data: { error: text } })
      throw new PushError(text, 504, 'UNKNOWN_RESULT')
    }
    await refuse(message, e instanceof CatkissfishError ? e.body : null)
    const hint = /logistic/i.test(message) ? ' — chưa có đơn nào được tạo. Đổi cách ship ở Setup › Fulfill rồi gửi lại' : ''
    throw new PushError(`CatKissFish từ chối đơn: ${message}${hint}`, 502, 'CREATE_FAILED')
  }

  // The lookup also gives the state; if it fails the create's own answer still names the order.
  const remote = await findOrder(session, built.externalOrderId).catch(() => null)
  return finish(remote ?? createdOrderOf(response), response)
}

async function remoteOf(session: CatkissfishSession, push: PushRow): Promise<CkfRemoteOrder | null> {
  return push.supplierOrderCode ? getOrder(session, push.supplierOrderCode) : findOrder(session, push.externalOrderId)
}

export async function cancelCatkissfishPush(orderId: string): Promise<{ push: PushView; exportReverted: boolean }> {
  const supplier = await findCatkissfishSupplier()
  const push = supplier ? await latestPush(orderId, supplier.id, ['SENDING', 'CREATED']) : null
  if (!push) throw new PushError('Đơn không có lần gửi CatKissFish nào đang hiệu lực', 404, 'NOT_FOUND')
  if (push.status === 'SENDING') throw new PushError('Chưa rõ kết quả lần gửi này — bấm "Cập nhật trạng thái" trước khi huỷ', 409, 'UNKNOWN_RESULT')
  const session = await sessionOrThrow()
  try {
    const remote = await remoteOf(session, push)
    if (!remote) throw new PushError(`CatKissFish không có đơn ${push.externalOrderId} — không có gì để huỷ, kiểm tra trên CatKissFish`, 404, 'NOT_FOUND')
    if (!isClosedState(remote.state)) await cancelOrder(session, remote.id)
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`CatKissFish không huỷ được đơn: ${e?.message ?? e}`, e instanceof CatkissfishError && e.unknownOutcome ? 504 : 502, 'CANCEL_FAILED')
  }
  const exportReverted = await closeCancelledPush(push, 'Huỷ đơn bên CatKissFish — đơn trở lại chờ chuyển xưởng')
  return { push: await viewOf(push.id), exportReverted }
}

/** Writes the order's tracking on its lines. Returns the note for a push whose numbers cannot be told apart. */
async function applyTracking(session: CatkissfishSession, push: PushRow, remote: CkfRemoteOrder): Promise<{ shipments: number; note: string | null }> {
  const rows = await getTrackingNumbers(session, remote.id)
  if (rows.length === 0) return { shipments: 0, note: null }
  const one = singleTracking(rows)
  if (!one) return { shipments: 0, note: `CatKissFish trả ${rows.length} mã tracking cho đơn này (${rows.map(r => r.number).join(', ')}) — không tự gán được, nhập tay đúng dòng` }
  return { shipments: await upsertLineTracking(push, () => ({ number: one.number, company: one.name })), note: null }
}

/** One push against CatKissFish: the order found lands it and brings its state and tracking; none found after the grace time means the send failed. */
async function refreshOne(session: CatkissfishSession, push: PushRow): Promise<{ found: boolean; shipments: number }> {
  const now = Date.now()
  const lastSyncedAt = new Date(now)
  const remote = await remoteOf(session, push)
  if (!remote) {
    const stale = push.status === 'SENDING' && now - push.pushedAt.getTime() > UNKNOWN_RESULT_GRACE_MS
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: stale
        ? { status: 'FAILED', activeKey: null, lastSyncedAt, error: 'CatKissFish không có đơn này — lần gửi không thành công, có thể gửi lại' }
        : { lastSyncedAt },
    })
    return { found: false, shipments: 0 }
  }

  const closed = isClosedState(remote.state)
  const unsettled = push.status === 'SENDING' || push.status === 'FAILED'
  const landed = unsettled && !closed
  const live = push.status === 'CREATED' || landed
  try {
    await prisma.supplierOrderPush.update({
      where: { id: push.id },
      data: {
        lastSyncedAt, remoteStatus: remote.stateLabel ?? push.remoteStatus, supplierOrderCode: push.supplierOrderCode ?? remote.id,
        ...(landed ? { status: 'CREATED', activeKey: push.activeKey ?? activeKeyFor(push.orderId, push.supplierId) } : {}),
        ...(push.status === 'SENDING' && closed ? { status: 'FAILED', activeKey: null, error: `CatKissFish đã huỷ đơn này (${remote.stateLabel}) — có thể gửi lại` } : {}),
        ...(live ? { error: closed ? `Đơn đang "${remote.stateLabel}" bên CatKissFish — kiểm tra rồi bấm Huỷ để đưa đơn về chờ gửi` : null } : {}),
      },
    })
  } catch (e: any) {
    if (isUniqueViolation(e)) throw new PushError(DUPLICATE_MESSAGE, 409, 'DUPLICATE')
    throw e
  }
  if (landed) await markPushExported(push)
  if (!live || closed || !hasLeftFactory(remote.state)) return { found: true, shipments: 0 }
  const tracking = await applyTracking(session, push, remote)
  if (tracking.note) await prisma.supplierOrderPush.update({ where: { id: push.id }, data: { error: tracking.note } })
  return { found: true, shipments: tracking.shipments }
}

export async function refreshCatkissfishPush(orderId: string): Promise<{ push: PushView; found: boolean; shipments: number }> {
  const supplier = await findCatkissfishSupplier()
  const push = supplier
    ? (await latestPush(orderId, supplier.id, ['SENDING', 'CREATED'])) ?? (await latestPush(orderId, supplier.id, ['CANCELLED', 'FAILED']))
    : null
  if (!push) throw new PushError('Đơn chưa từng gửi CatKissFish', 404, 'NOT_FOUND')
  const session = await sessionOrThrow()
  try {
    const { found, shipments } = await refreshOne(session, push)
    return { push: await viewOf(push.id), found, shipments }
  } catch (e: any) {
    if (e instanceof PushError) throw e
    throw new PushError(`Không lấy được trạng thái từ CatKissFish: ${e?.message ?? e}`, e instanceof CatkissfishError && e.unknownOutcome ? 504 : 502, 'REFRESH_FAILED')
  }
}

/** Status and tracking of every open CatKissFish push. Tracking lands on Shipment rows; Auto Fulfill turns those into Shopify fulfillments. */
export async function syncCatkissfishTracking(): Promise<{ pushes: number; found: number; shipments: number; skipped?: string }> {
  const supplier = await findCatkissfishSupplier()
  if (!supplier) return { pushes: 0, found: 0, shipments: 0, skipped: 'no CatKissFish supplier' }
  const settings = await getCatkissfishSettings()
  if (!hasCatkissfishAccount(settings)) return { pushes: 0, found: 0, shipments: 0, skipped: 'no CatKissFish account' }
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const pushes = await prisma.supplierOrderPush.findMany({
    where: { supplierId: supplier.id, status: { in: ACTIVE_STATUSES }, pushedAt: { gte: since }, order: { pipelineStatus: { notIn: ['FULFILLED', ...CLOSED_PIPELINE] } } },
  })
  const session = catkissfishSession(settings)
  let found = 0
  let shipments = 0
  for (const push of pushes) {
    try {
      const r = await refreshOne(session, push)
      if (r.found) found++
      shipments += r.shipments
    } catch (e: any) {
      console.error('[catkissfish] tracking sync failed for push', push.id, e?.message ?? e)
    }
  }
  return { pushes: pushes.length, found, shipments }
}

export type CatkissfishSetupInfo = { skus: { sku: string; styleCode: string | null }[]; unpaidOrders: number }

/** What the settings card shows beside the key: the style each SKU sends, and the orders still waiting for payment on CatKissFish. */
export async function catkissfishSetupInfo(): Promise<CatkissfishSetupInfo> {
  const supplier = await findCatkissfishSupplier()
  if (!supplier) return { skus: [], unpaidOrders: 0 }
  const [products, unpaidOrders] = await Promise.all([
    prisma.supplierProduct.findMany({ where: { supplierId: supplier.id }, select: { sku: true, apiSku: true }, orderBy: { sku: 'asc' } }),
    prisma.supplierOrderPush.count({ where: { supplierId: supplier.id, status: 'CREATED', remoteStatus: CKF_UNPAID_LABEL } }),
  ])
  return { skus: products.map(p => ({ sku: p.sku, styleCode: styleCodeOf(p) })), unpaidOrders }
}

export type CatkissfishConnectionCheck = {
  tokenExpiresAt: string | null
  styles: { styleCode: string; name: string | null; colors: string[]; sizes: string[]; areas: string[]; error: string | null }[]
}

/** Asks for a new token, which proves the key, then reads the styles the tool sends. Creates nothing. */
export async function checkCatkissfishConnection(): Promise<CatkissfishConnectionCheck> {
  const session = catkissfishSession(await getCatkissfishSettings())
  await session.renew()
  const { skus } = await catkissfishSetupInfo()
  const codes = Array.from(new Set(skus.map(s => s.styleCode).filter((s): s is string => !!s)))
  const styles: CatkissfishConnectionCheck['styles'] = []
  for (const styleCode of codes) {
    try {
      const d = await getProductDetail(session, styleCode)
      styles.push({ styleCode, name: d?.name ?? null, colors: d?.colors ?? [], sizes: d?.sizes ?? [], areas: d?.dimensions.map(x => x.fieldName) ?? [], error: d ? null : 'CatKissFish không có style này' })
    } catch (e: any) {
      styles.push({ styleCode, name: null, colors: [], sizes: [], areas: [], error: e?.message ?? String(e) })
    }
  }
  return { tokenExpiresAt: (await getCatkissfishSettings()).tokenExpiresAt, styles }
}
