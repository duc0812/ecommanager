import { prisma } from '@/lib/db'
import { DROPSHIP_TASK_MESSAGE, syncDesignTasksCounted } from '@/lib/design-tasks'
import { isOrderClosed } from '@/lib/line-export'

/** Shopify product ids the store sells as dropship (bought ready-made: no print file, only a supplier mapping). */
export async function dropshipProductIds(storeId: string): Promise<Set<string>> {
  const rows = await prisma.productProfile.findMany({ where: { storeId, dropship: true }, select: { shopifyProductId: true } })
  return new Set(rows.map(r => r.shopifyProductId))
}

export const DROPSHIP_PUSH_REFUSAL = 'Dropship — gửi bằng CSV hoặc Bondre'
export const DROPSHIP_OFF_MESSAGE = 'Bỏ dropship — mở lại task design'

const OPEN_TASK = { notIn: ['DONE', 'CANCELLED'] }

/**
 * Copies the product's flag onto every line of it. Turning it on cancels the open design tasks of those lines (closed
 * orders too, so a robe fulfilled outside the tool stops showing as "shipped without a file"); turning it off reopens,
 * on open orders only, the tasks that the flag had cancelled.
 */
export async function applyDropship(storeId: string, shopifyProductId: string, on: boolean): Promise<{ lines: number; tasks: number }> {
  const where = { shopifyProductId, order: { storeId } }
  const { count } = await prisma.orderLine.updateMany({ where: { ...where, dropship: !on }, data: { dropship: on } })
  const lines = await prisma.orderLine.findMany({
    where,
    select: { orderId: true, shopifyLineId: true, order: { select: { pipelineStatus: true, financialStatus: true, fulfillmentStatus: true } } },
  })
  if (lines.length === 0) return { lines: count, tasks: 0 }
  const lineIds = new Set(lines.map(l => `${l.orderId}\u0000${l.shopifyLineId}`))
  const orderIds = Array.from(new Set(lines.map(l => l.orderId)))
  if (on) {
    const open = await prisma.designTask.findMany({ where: { orderId: { in: orderIds }, status: OPEN_TASK }, select: { orderId: true, shopifyLineId: true } })
    const touched = Array.from(new Set(open.filter(t => lineIds.has(`${t.orderId}\u0000${t.shopifyLineId}`)).map(t => t.orderId)))
    const { tasksTouched } = await syncDesignTasksCounted(touched)
    return { lines: count, tasks: tasksTouched }
  }
  const openOrders = new Set(lines.filter(l => !isOrderClosed(l.order)).map(l => l.orderId))
  const cancelled = await prisma.designTask.findMany({
    where: { orderId: { in: Array.from(openOrders) }, status: 'CANCELLED', events: { some: { message: DROPSHIP_TASK_MESSAGE } } },
    select: { id: true, orderId: true, shopifyLineId: true },
  })
  const reopen = cancelled.filter(t => lineIds.has(`${t.orderId}\u0000${t.shopifyLineId}`))
  for (const t of reopen) {
    await prisma.designTask.update({ where: { id: t.id }, data: { status: 'NEW', events: { create: { type: 'SYSTEM', message: DROPSHIP_OFF_MESSAGE } } } })
  }
  return { lines: count, tasks: reopen.length }
}

export type DropshipRow = {
  lineId: string; orderId: string; orderNumber: string; storeId: string; store: string; placedAt: string
  productTitle: string; variantTitle: string | null; qty: number; sku: string | null; imageUrl: string | null
  shopifyVariantId: string | null; shopifyProductId: string | null
  supplier: { id: string; name: string } | null; supplierSku: string | null
}

/** Dropship lines not sent yet, on open orders: the unmapped ones first, then those waiting to be sent. */
export async function listDropshipLines(opts: { q?: string } = {}): Promise<{ unmapped: DropshipRow[]; mapped: DropshipRow[] }> {
  const q = opts.q?.trim()
  const lines = await prisma.orderLine.findMany({
    where: {
      dropship: true, exportedAt: null,
      ...(q ? { OR: [{ productTitle: { contains: q } }, { sku: { contains: q } }, { order: { shopifyOrderNumber: { contains: q } } }] } : {}),
    },
    select: {
      id: true, orderId: true, productTitle: true, variantTitle: true, qty: true, sku: true, imageUrl: true, shopifyVariantId: true, shopifyProductId: true,
      resolvedSupplierId: true, resolvedSupplierSku: true,
      order: { select: { storeId: true, shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, financialStatus: true, fulfillmentStatus: true, store: { select: { shop: true } } } },
    },
    orderBy: { order: { placedAt: 'asc' } },
    take: 500,
  })
  const open = lines.filter(l => !isOrderClosed(l.order))
  const supplierIds = Array.from(new Set(open.map(l => l.resolvedSupplierId).filter((x): x is string => !!x)))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(suppliers.map(s => [s.id, s.name]))
  const rows: DropshipRow[] = open.map(l => ({
    lineId: l.id, orderId: l.orderId, orderNumber: l.order.shopifyOrderNumber, storeId: l.order.storeId, store: l.order.store?.shop.replace(/\.myshopify\.com$/, '') ?? '',
    placedAt: l.order.placedAt.toISOString(), productTitle: l.productTitle, variantTitle: l.variantTitle, qty: l.qty, sku: l.sku,
    imageUrl: l.imageUrl, shopifyVariantId: l.shopifyVariantId, shopifyProductId: l.shopifyProductId,
    supplier: l.resolvedSupplierId ? { id: l.resolvedSupplierId, name: nameById.get(l.resolvedSupplierId) ?? '—' } : null,
    supplierSku: l.resolvedSupplierSku,
  }))
  return { unmapped: rows.filter(r => !r.supplier), mapped: rows.filter(r => !!r.supplier) }
}
