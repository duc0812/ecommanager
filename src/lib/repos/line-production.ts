import { prisma } from '@/lib/db'
import { supplierParentKey } from '@/lib/product-mapping'
import { applyProductionOverride, productionOverride, variantOptions, type ProductionOverride, type ProductionSource } from '@/lib/production-override'
import { isLineExported, isOrderClosed } from '@/lib/line-export'
import { sizeLabel } from '@/lib/sheet-channel'

export class ProductionEditError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

async function context(taskKey: string) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, include: { order: true } })
  if (!task) throw new ProductionEditError('Không tìm thấy task', 404)
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) throw new ProductionEditError('Dòng hàng đang đồng bộ, vui lòng thử lại', 409)
  const current = line.resolvedSupplierId && line.resolvedSupplierSku
    ? await prisma.supplierProduct.findUnique({ where: { supplierId_sku: { supplierId: line.resolvedSupplierId, sku: line.resolvedSupplierSku } }, include: { supplier: true } }) : null
  return { task, line, current }
}

export async function productionEditView(taskKey: string) {
  const { task, line, current } = await context(taskKey)
  const options = current ? await prisma.supplierProduct.findMany({
    where: { supplierId: current.supplierId, baseSku: current.baseSku, productName: current.productName, productType: current.productType, variant2Value: current.variant2Value },
    select: { id: true, sku: true, variant1Value: true, variant2Value: true, printTemplateId: true }, orderBy: { sku: 'asc' },
  }) : []
  return {
    revision: line.productionOverrideJson, currentProductId: current?.id ?? null,
    variantTitle: line.variantTitle, variantOptions: variantOptions(line.variantOptions),
    override: productionOverride(line.productionOverrideJson),
    editable: !['DONE', 'CANCELLED'].includes(task.status) && !isOrderClosed(task.order) && !isLineExported({ ...task.order, lines: [line] }, line) && !task.order.supplierHandoffAt,
    options: options.map(p => ({ id: p.id, sku: p.sku, size: sizeLabel(p.variant1Value, line.variantTitle), color: p.variant2Value, templateId: p.printTemplateId })),
  }
}

export async function editLineProduction(taskKey: string, input: { supplierProductId: unknown; customName?: unknown; reason: unknown; revision: unknown }, actor: { id: string; name: string }) {
  if (typeof input.supplierProductId !== 'string' || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1500) throw new ProductionEditError('Chọn mã hàng xưởng và ghi lý do chỉnh sửa')
  if (input.customName !== undefined && input.customName !== null && (typeof input.customName !== 'string' || input.customName.length > 200)) throw new ProductionEditError('Tên custom phải là chữ, tối đa 200 ký tự')
  if (input.revision !== null && typeof input.revision !== 'string') throw new ProductionEditError('Thiếu phiên bản dữ liệu, tải lại task trước khi sửa', 409)
  const { task, line, current } = await context(taskKey)
  if (!current || !current.supplier.isActive) throw new ProductionEditError('Dòng hàng chưa có mã xưởng hợp lệ', 409)
  const selected = await prisma.supplierProduct.findUnique({ where: { id: input.supplierProductId }, include: { supplier: true } })
  if (!selected || !selected.supplier.isActive || supplierParentKey(selected) !== supplierParentKey(current) || selected.variant2Value !== current.variant2Value) throw new ProductionEditError('Chỉ chọn size cùng sản phẩm, màu và xưởng của dòng này')
  const size = sizeLabel(selected.variant1Value, null)
  if (!size || !/^(?:[2-9]?XL|XXL|XXXL|XS|S|M|L|[2-9]XS|ONE SIZE|\d.*)$/i.test(size)) throw new ProductionEditError('Mã xưởng này chưa có size rõ ràng')
  if (line.productionOverrideJson !== input.revision) throw new ProductionEditError('Thông tin đã được người khác sửa, tải lại task', 409)
  const previous = productionOverride(line.productionOverrideJson)
  const opts = variantOptions(previous?.source.variantOptions ?? line.variantOptions)
  const sizeKey = Object.keys(opts).find(k => /^(size|kích cỡ|kich co)$/i.test(k)) ?? 'Size'
  opts[sizeKey] = size
  const now = new Date()
  const shipping = selected.shippingByRegion ? JSON.parse(selected.shippingByRegion) : {}
  const rate = shipping[task.order.shippingZone ?? 'ROW']
  const source: ProductionSource = previous?.source ?? {
    variantTitle: line.variantTitle, variantOptions: line.variantOptions, resolvedSupplierSku: line.resolvedSupplierSku,
    customAttributesJson: line.customAttributesJson, customallFieldsJson: line.customallFieldsJson,
  }
  const customName = input.customName === undefined || input.customName === null ? previous?.customName ?? null : String(input.customName).trim()
  const sourceOptions = variantOptions(source.variantOptions)
  const originalSize = Object.entries(sourceOptions).find(([k]) => /^(size|kích cỡ|kich co)$/i.test(k))?.[1] ?? sizeLabel(current.variant1Value, null)
  const parts = (source.variantTitle ?? '').split('/').map(p => p.trim())
  const title = parts.includes(originalSize) ? parts.map(p => p === originalSize ? size : p).join(' / ') : Object.values(opts).join(' / ')
  const value: ProductionOverride = {
    version: 1, supplierProductId: selected.id, supplierId: selected.supplierId, supplierSku: selected.sku,
    variantTitle: title, variantOptions: opts, customName,
    baseCost: selected.baseCost, shipFirst: rate?.first ?? selected.supplier.firstItemShipFee,
    shipAdditional: rate?.additional ?? selected.supplier.additionalItemShipFee, importTax: rate?.importTax ?? 0,
    source, history: [...(previous?.history ?? []), { at: now.toISOString(), byId: actor.id, byName: actor.name, reason: input.reason.trim(), from: `${line.variantTitle ?? ''} · ${line.resolvedSupplierSku ?? ''}`, to: `${title} · ${selected.sku}${customName !== null ? ` · Custom Name: ${customName || 'No'}` : ''}` }],
  }
  const effective = applyProductionOverride(line, value)
  await prisma.$transaction(async tx => {
    const fresh = await tx.orderLine.findFirst({ where: { id: line.id }, include: { order: true } })
    const freshTask = await tx.designTask.findUniqueOrThrow({ where: { id: task.id } })
    const livePush = await tx.supplierOrderPush.findFirst({ where: { orderId: task.orderId, status: { in: ['CREATED', 'SENDING'] } }, select: { id: true } })
    const sheetWrite = await tx.supplierSheetWrite.findFirst({ where: { orderId: task.orderId, orderLineId: line.id, status: { in: ['WRITING', 'WRITTEN'] } }, select: { id: true } })
    if (!fresh || fresh.productionOverrideJson !== input.revision) throw new ProductionEditError('Dữ liệu đã đổi, tải lại task', 409)
    const render = await tx.artworkJob.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId, kind: 'RENDER_LINE', status: { in: ['QUEUED', 'PENDING', 'RUNNING'] } }, select: { id: true } })
    if (render) throw new ProductionEditError('Đang render artwork, đợi hoàn tất trước khi chỉnh thông tin sản xuất', 409)
    if (['DONE', 'CANCELLED'].includes(freshTask.status) || isOrderClosed(fresh.order) || isLineExported({ ...fresh.order, lines: [fresh] }, fresh) || fresh.order.supplierHandoffAt || livePush || sheetWrite) throw new ProductionEditError('Dòng đã đóng, duyệt hoặc chuyển xưởng. Mở lại xử lý trước khi sửa thông tin sản xuất.', 409)
    const changed = await tx.orderLine.updateMany({ where: { id: line.id, productionOverrideJson: input.revision as string | null }, data: {
      variantTitle: effective.variantTitle, variantOptions: effective.variantOptions, resolvedSupplierId: selected.supplierId, resolvedSupplierSku: selected.sku,
      resolvedBaseCost: effective.resolvedBaseCost, resolvedShipFirst: effective.resolvedShipFirst, resolvedShipAdditional: effective.resolvedShipAdditional, resolvedImportTax: effective.resolvedImportTax,
      costSnapshotAt: now, customAttributesJson: effective.customAttributesJson, customallFieldsJson: effective.customallFieldsJson,
      ...(line.resolvedSupplierSku !== selected.sku ? { manualBaseCost: null } : {}),
      ...(customName !== null ? { customized: !!customName } : {}), productionOverrideJson: JSON.stringify(value),
      designDriveLink: null,
    } })
    if (changed.count !== 1) throw new ProductionEditError('Dữ liệu đã đổi, tải lại task', 409)
    await tx.order.update({ where: { id: task.orderId }, data: { designReady: false, pipelineStatus: fresh.order.pipelineStatus === 'DESIGN_REJECTED' ? 'DESIGN_REJECTED' : 'PENDING_DESIGN', ...(customName ? { orderType: 'CUSTOM' } : {}) } })
    const last = value.history[value.history.length - 1]
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', actorId: actor.id, message: `Chỉnh thông tin sản xuất: ${last.from} → ${last.to}. Lý do: ${last.reason}` } })
  })
  return productionEditView(taskKey)
}
