import { prisma } from '@/lib/db'
import { applyProductionOverride, productionOverride, variantOptions, type ProductionOverride, type ProductionSource } from '@/lib/production-override'
import { legacyMarks, pushLineIds, pushShopifyLineIds, supplierLines } from '@/lib/line-export'
import { lineKeysOf } from '@/lib/order-lines'

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

export async function moveUnsentLine(
  taskKey: string,
  input: { supplierProductId: unknown; reason: unknown },
  actor: { id: string; name: string },
) {
  if (typeof input.supplierProductId !== 'string' || !input.supplierProductId) throw new MoveLineError('Chọn mã hàng của xưởng mới')
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 1500) throw new MoveLineError('Ghi lý do chuyển xưởng (3–1500 ký tự)')
  const reason = input.reason.trim()

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

    const sheetRow = await tx.supplierSheetWrite.findFirst({ where: { orderId: order.id, orderLineId: line.id, status: { in: ['WRITING', 'WRITTEN'] } }, select: { id: true } })
    if (sheetRow) throw new MoveLineError('Dòng đã được ghi vào sheet của xưởng — xưởng đã nhận, không chuyển được', 409)
    const pushes = await tx.supplierOrderPush.findMany({ where: { orderId: order.id, status: { in: LIVE_PUSH } }, select: { supplierId: true, prevExportJson: true } })
    const carried = pushes.find(p => {
      const ids = pushLineIds(p)
      const shopifyIds = pushShopifyLineIds(p)
      if (ids || shopifyIds) return (ids ?? []).includes(line.id) || (shopifyIds ?? []).includes(line.shopifyLineId)
      // A push made before sends went by line carried every line of its supplier.
      return p.supplierId === (line.exportedToSupplierId ?? line.resolvedSupplierId)
    })
    if (carried) throw new MoveLineError('Dòng nằm trong một lần gửi API còn hiệu lực — huỷ lần gửi đó trước', 409)
    const lineKey = lineKeysOf(order.shopifyOrderNumber, order.lines).get(line.shopifyLineId)
    const shipment = lineKey ? await tx.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } }, select: { id: true, trackingNumber: true } }) : null
    if (shipment?.trackingNumber) {
      // A fulfillment that closed the whole order copies a sibling's parcel onto an unsent line (#LIT5519_2): that number is
      // borrowed, not this line's own. Only a line no supplier was marked for, sharing the number with a sibling, counts as borrowed.
      const sibling = line.exportedAt ? null : await tx.shipment.findFirst({
        where: { orderId: order.id, trackingNumber: shipment.trackingNumber, NOT: { id: shipment.id } }, select: { id: true },
      })
      if (!sibling) throw new MoveLineError(`Dòng đã có tracking ${shipment.trackingNumber} — xưởng đã gửi hàng, không chuyển được`, 409)
    }
    const render = await tx.artworkJob.findFirst({ where: { orderId: order.id, shopifyLineId: line.shopifyLineId, kind: 'RENDER_LINE', status: { in: ['QUEUED', 'PENDING', 'RUNNING'] } }, select: { id: true } })
    if (render) throw new MoveLineError('Đang render artwork, đợi hoàn tất rồi chuyển xưởng', 409)

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
      },
    })
    if (changed.count !== 1) throw new MoveLineError('Dữ liệu dòng vừa đổi, tải lại rồi thử lại', 409)
    if (shipment) await tx.shipment.update({ where: { id: shipment.id }, data: { supplierId: selected.supplierId } })

    // The hub lists orders that can still send: an order Exported only because of this mark opens again for the line.
    const others = supplierLines(order.lines.filter(l => l.id !== line.id))
    const reopen = order.pipelineStatus === 'EXPORTED'
    if (reopen) await tx.order.update({ where: { id: order.id }, data: { pipelineStatus: 'READY_TO_PRODUCTION' } })

    const message = `${MOVE_EVENT_PREFIX}: ${fromLabel} → ${toLabel}${markNote}. Lý do: ${reason}`
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', actorId: actor.id, message } })
    return {
      taskKey, lineId: line.id, from: fromLabel, to: toLabel, clearedExportMark: !!line.exportedAt,
      orderReopened: reopen, otherSupplierLines: others.length, message,
    }
  })
}
