import { prisma } from '@/lib/db'
import { applyProductionOverride, productionOverride, variantOptions, type ProductionOverride, type ProductionSource } from '@/lib/production-override'
import { isOrderClosed, legacyMarks, pushLineIds, pushShopifyLineIds, supplierLines } from '@/lib/line-export'
import { lineKeysOf } from '@/lib/order-lines'
import { closeReturnedAssignment } from '@/lib/design-outsource-routing'
import { loadTemplateContext, pickTemplate } from '@/lib/print-template-resolve'

/**
 * Owner 11/21/2026 (#LIT5707_1): a line the tool marks as sent (a CSV download) that no supplier ever received — no sheet row,
 * no live push, no tracking of its own — can move to another supplier on its own: the mark goes, the line resolves to the
 * chosen supplier product (kept through the order sync as a production override) and goes out with that supplier's next send.
 */
export class MoveLineError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
const LIVE_PUSH = ['SENDING', 'CREATED']

export const MOVE_EVENT_PREFIX = 'Chuyển xưởng dòng chưa xưởng nào nhận'
/**
 * Owner 11/28/2026 (#LIT5958_1): a line whose parcel left but never arrived (Yanwen stuck at INFO_RECEIVED) goes out again from
 * another supplier. The super admin confirms the reship: the old supplier's sheet row, landed push and parcel stay as history,
 * the line resolves to the new product and loses its export mark so the new supplier's send can carry it.
 */
export const RESHIP_EVENT_PREFIX = 'Ship lại qua xưởng khác'
const RESHIP_NOT_NEEDED = 'Dòng chưa có tracking và đơn chưa giao — dùng chuyển xưởng thường, không phải ship lại'

export async function moveUnsentLine(
  taskKey: string,
  input: { supplierProductId: unknown; reason: unknown; reship?: unknown },
  actor: { id: string; name: string },
  refusal?: { sourceId: string; sourceSku: string; dryRun: boolean; sheetRow: number | null; spreadsheetId: string; tab: string },
) {
  if (typeof input.supplierProductId !== 'string' || !input.supplierProductId) throw new MoveLineError('Chọn mã hàng của xưởng mới')
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 1500) throw new MoveLineError('Ghi lý do chuyển xưởng (3–1500 ký tự)')
  const reason = input.reason.trim()
  const reship = input.reship === true
  if (reship && refusal) throw new MoveLineError('Ship lại không đi cùng từ chối của xưởng')

  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) throw new MoveLineError('Không tìm thấy task', 404)
  if (task.status === 'CANCELLED') throw new MoveLineError('Task đã huỷ — mở lại task trước khi chuyển xưởng', 409)
  const selected = await prisma.supplierProduct.findUnique({ where: { id: input.supplierProductId }, include: { supplier: true } })
  if (!selected || !selected.supplier.isActive) throw new MoveLineError('Mã hàng xưởng không tồn tại hoặc xưởng đã tắt', 404)

  const now = new Date()
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: task.orderId }, include: { lines: { orderBy: { linePosition: 'asc' } } } })
    const line = order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    if (!line) throw new MoveLineError('Dòng hàng đang đồng bộ, vui lòng thử lại', 409)
    if (CLOSED_PIPELINE.includes(order.pipelineStatus) || CLOSED_FINANCIAL.includes((order.financialStatus ?? '').toUpperCase())) {
      throw new MoveLineError('Đơn đã huỷ hoặc hoàn tiền — không chuyển xưởng', 409)
    }
    if (line.resolvedSupplierId === selected.supplierId && line.resolvedSupplierSku === selected.sku && !line.exportedAt) {
      throw new MoveLineError('Dòng đã ở đúng mã hàng này', 409)
    }

    const sheetWrites = await tx.supplierSheetWrite.findMany({ where: {
      orderId: order.id, OR: [{ orderLineId: line.id }, { lineKey: taskKey }], status: { in: ['WRITING', 'WRITTEN'] },
    } })
    if (sheetWrites.length && !refusal && !reship) throw new MoveLineError('Dòng đã được ghi vào sheet của xưởng — xưởng đã nhận, không chuyển được', 409)
    if (refusal) {
      if (isOrderClosed(order) || order.financialStatus.toUpperCase() !== 'PAID' || line.dropship) throw new MoveLineError('Dòng không còn ở trạng thái chờ sản xuất đã thanh toán', 409)
      if (line.resolvedSupplierId !== refusal.sourceId || line.resolvedSupplierSku !== refusal.sourceSku ||
          (line.exportedToSupplierId && line.exportedToSupplierId !== refusal.sourceId) || selected.supplierId === refusal.sourceId) {
        throw new MoveLineError('Mapping hoặc xưởng nhận đã thay đổi', 409)
      }
      if (sheetWrites.some(w => w.status !== 'WRITTEN' || w.supplierId !== refusal.sourceId || w.spreadsheetId !== refusal.spreadsheetId || w.tabName !== refusal.tab || !refusal.sheetRow)) {
        throw new MoveLineError('Lịch sử ghi sheet khác dữ liệu đối chiếu hoặc đang ghi', 409)
      }
      const lookup = { ...line, resolvedSupplierId: selected.supplierId, resolvedSupplierSku: selected.sku }
      const profile = line.shopifyProductId ? await tx.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId: order.storeId, shopifyProductId: line.shopifyProductId } }, select: { printTemplateId: true } }) : null
      const template = pickTemplate(lookup, profile, await loadTemplateContext([lookup], [profile?.printTemplateId], tx))
      if (!template || !template.areas.length || template.id !== selected.printTemplateId) throw new MoveLineError('Template task chưa khớp SKU đích', 409)
      const parcel = await tx.shipment.findFirst({ where: { orderId: order.id, OR: [{ lineKey: taskKey }, { shopifyLineId: line.shopifyLineId }], AND: [{ OR: [{ trackingNumber: { not: null } }, { status: { notIn: ['PENDING', 'UNKNOWN'] } }] }] }, select: { id: true } })
      if (parcel) throw new MoveLineError('Dòng có tracking hoặc đã giao vận', 409)
      const activeJob = await tx.designAgentJob.findFirst({ where: { taskId: task.id, status: { in: ['QUEUED','RUNNING'] } }, select: { id: true } })
      if (activeJob) throw new MoveLineError('Design Agent đang giữ dòng này', 409)
    }
    const pushes = await tx.supplierOrderPush.findMany({ where: { orderId: order.id, status: { in: LIVE_PUSH } }, select: { supplierId: true, status: true, prevExportJson: true } })
    const carried = pushes.find(p => {
      const ids = pushLineIds(p)
      const shopifyIds = pushShopifyLineIds(p)
      if (ids || shopifyIds) return (ids ?? []).includes(line.id) || (shopifyIds ?? []).includes(line.shopifyLineId)
      // A push made before sends went by line carried every line of its supplier.
      return p.supplierId === (line.exportedToSupplierId ?? line.resolvedSupplierId)
    })
    // A reship leaves a landed push as the record of the first send; one still without an answer may yet become that first send.
    if (carried && !(reship && carried.status === 'CREATED')) throw new MoveLineError('Dòng nằm trong một lần gửi API còn hiệu lực — huỷ lần gửi đó trước', 409)
    const lineKey = lineKeysOf(order.shopifyOrderNumber, order.lines).get(line.shopifyLineId)
    if (refusal && lineKey !== taskKey) throw new MoveLineError('Mã dòng trong đơn vừa thay đổi', 409)
    const shipment = lineKey ? await tx.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } }, select: { id: true, trackingNumber: true } }) : null
    let previousTracking: string | null = null
    if (shipment?.trackingNumber) {
      // A fulfillment that closed the whole order copies a sibling's parcel onto an unsent line (#LIT5519_2): that number is
      // borrowed, not this line's own. Only a line no supplier was marked for, sharing the number with a sibling, counts as borrowed.
      const sibling = line.exportedAt ? null : await tx.shipment.findFirst({
        where: { orderId: order.id, trackingNumber: shipment.trackingNumber, NOT: { id: shipment.id } }, select: { id: true },
      })
      if (!sibling) {
        if (!reship) throw new MoveLineError(`Dòng đã có tracking ${shipment.trackingNumber} — xưởng đã gửi hàng, không chuyển được`, 409)
        previousTracking = shipment.trackingNumber
      }
    }
    const shipped = order.pipelineStatus === 'FULFILLED' || (order.fulfillmentStatus ?? '').toUpperCase() === 'FULFILLED'
    if (reship && !shipped && !previousTracking) throw new MoveLineError(RESHIP_NOT_NEEDED, 409)
    const render = await tx.artworkJob.findFirst({ where: { orderId: order.id, shopifyLineId: line.shopifyLineId, kind: 'RENDER_LINE', status: { in: ['QUEUED', 'PENDING', 'RUNNING'] } }, select: { id: true } })
    if (render) throw new MoveLineError('Đang render artwork, đợi hoàn tất rồi chuyển xưởng', 409)

    if (refusal?.dryRun) return { taskKey, verified: true, target: selected.sku }
    const fromSupplier = line.exportedToSupplierId ?? line.resolvedSupplierId
    const from = fromSupplier ? await tx.supplier.findUnique({ where: { id: fromSupplier }, select: { name: true } }) : null
    const previous = productionOverride(line.productionOverrideJson)
    const source: ProductionSource = previous?.source ?? {
      variantTitle: line.variantTitle, variantOptions: line.variantOptions, resolvedSupplierSku: line.resolvedSupplierSku,
      customAttributesJson: line.customAttributesJson, customallFieldsJson: line.customallFieldsJson,
    }
    const shipping = selected.shippingByRegion ? JSON.parse(selected.shippingByRegion) : {}
    const rate = shipping[order.shippingZone ?? 'ROW']
    const markNote = line.exportedAt ? `, gỡ dấu đã xuất ${line.exportedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''
    const fromLabel = `${from?.name ?? 'chưa có xưởng'} ${line.resolvedSupplierSku ?? ''}`.trim()
    const toLabel = `${selected.supplier.name} ${selected.sku}`
    const value: ProductionOverride = {
      version: 1, supplierProductId: selected.id, supplierId: selected.supplierId, supplierSku: selected.sku,
      variantTitle: previous?.variantTitle ?? line.variantTitle ?? '', variantOptions: previous?.variantOptions ?? variantOptions(line.variantOptions),
      customName: previous?.customName ?? null,
      baseCost: selected.baseCost, shipFirst: rate?.first ?? selected.supplier.firstItemShipFee,
      shipAdditional: rate?.additional ?? selected.supplier.additionalItemShipFee, importTax: rate?.importTax ?? 0,
      source, history: [...(previous?.history ?? []), { at: now.toISOString(), byId: actor.id, byName: actor.name, reason, from: fromLabel, to: toLabel }],
    }
    const effective = applyProductionOverride(line, value)

    // An order exported before lines were tracked first gets the marks its old export implies for its other lines.
    for (const m of legacyMarks(order).filter(x => x.line.id !== line.id)) {
      await tx.orderLine.updateMany({ where: { id: m.line.id, exportedAt: null }, data: { exportedAt: order.exportedAt, exportedToSupplierId: m.supplierId } })
    }
    const changed = await tx.orderLine.updateMany({
      where: { id: line.id, productionOverrideJson: line.productionOverrideJson, exportedAt: line.exportedAt },
      data: {
        resolvedSupplierId: selected.supplierId, resolvedSupplierSku: selected.sku,
        resolvedBaseCost: effective.resolvedBaseCost, resolvedShipFirst: effective.resolvedShipFirst,
        resolvedShipAdditional: effective.resolvedShipAdditional, resolvedImportTax: effective.resolvedImportTax,
        costSnapshotAt: now, manualBaseCost: null, productionOverrideJson: JSON.stringify(value),
        exportedAt: null, exportedToSupplierId: null,
        ...(refusal ? { designDriveLink: null } : {}),
      },
    })
    if (changed.count !== 1) throw new MoveLineError('Dữ liệu dòng vừa đổi, tải lại rồi thử lại', 409)
    // The parcel on a reshipped line is the old supplier's; the new one's tracking lands when its own send is refreshed.
    if (shipment && !reship) await tx.shipment.update({ where: { id: shipment.id }, data: { supplierId: selected.supplierId } })

    // The hub lists orders that can still send: an order Exported only because of this mark opens again for the line.
    const others = supplierLines(order.lines.filter(l => l.id !== line.id))
    const reopen = order.pipelineStatus === 'EXPORTED'
    if (refusal) {
      const freshTask = await tx.designTask.findUniqueOrThrow({ where: { id: task.id } })
      if (freshTask.status === 'CANCELLED') throw new MoveLineError('Task đã hủy', 409)
      const atSheet = refusal.sheetRow ? ` (${refusal.tab}, dòng ${refusal.sheetRow})` : ''
      const note = `Xưởng từ chối sản xuất${atSheet}: ${fromLabel} → ${toLabel}. ${reason}`
      await tx.supplierSheetWrite.updateMany({ where: { id: { in: sheetWrites.map(w => w.id) }, status: 'WRITTEN' }, data: { status: 'DECLINED' } })
      const retired = await tx.designArtwork.updateMany({ where: { orderId: order.id, shopifyLineId: line.shopifyLineId, kind: { in: ['PRINT', 'MOCKUP'] }, removedAt: null }, data: { removedAt: now, removedById: actor.id } })
      const openStatus = ['NEW', 'DOING', 'ASK_CUSTOMER'].includes(freshTask.status)
      await tx.designTask.update({ where: { id: task.id }, data: {
        ...await closeReturnedAssignment(tx, task.id), supplierSnapshot: selected.supplier.name, fromLibrary: false, readiness: 'MANUAL',
        ...(!openStatus ? { status: 'REJECTED', rejectReasons: JSON.stringify(['Xưởng yêu cầu update design']), rejectNote: note, prevStatus: null } : {}),
        events: { create: { type: 'SYSTEM', actorId: actor.id, message: `${note}. Lưu lịch sử ${retired.count} file. Link file trước khi đổi: ${line.designDriveLink ?? '—'}` } },
      } })
      const siblingSent = await tx.orderLine.count({ where: { orderId: order.id, id: { not: line.id }, exportedAt: { not: null } } })
      await tx.order.update({ where: { id: order.id }, data: {
        pipelineStatus: 'PENDING_DESIGN', designReady: false,
        ...(!siblingSent ? { exportedAt: null, exportedToSupplierId: null, supplierHandoffAt: null, supplierHandoffMode: null, supplierHandoffById: null } : {}),
        ...(others.length === 0 ? { designDriveLink: null } : {}),
      } })
      return { taskKey, target: selected.sku, retired: retired.count, verified: true }
    }
    if (reopen) await tx.order.update({ where: { id: order.id }, data: { pipelineStatus: 'READY_TO_PRODUCTION' } })

    const parcelNote = previousTracking ? `, kiện cũ ${previousTracking} giữ nguyên` : ''
    const message = `${reship ? RESHIP_EVENT_PREFIX : MOVE_EVENT_PREFIX}: ${fromLabel} → ${toLabel}${markNote}${parcelNote}. Lý do: ${reason}`
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', actorId: actor.id, message } })
    return {
      taskKey, lineId: line.id, from: fromLabel, to: toLabel, clearedExportMark: !!line.exportedAt,
      orderReopened: reopen, otherSupplierLines: others.length, reship, previousTracking, message,
    }
  })
}
