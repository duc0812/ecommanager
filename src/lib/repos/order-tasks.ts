import { prisma } from '@/lib/db'
import { detectOrderTasks, type OrderTask, type TaskType } from '@/lib/order-tasks'
import { isNonProductLine } from '@/lib/order-lines'

const ACTIVE_WHERE = { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } }

export type FixLine = { lineId: string; shopifyVariantId: string | null; productTitle: string; sku: string | null }

export type TaskRow = {
  orderId: string
  shopifyOrderNumber: string
  placedAt: Date
  projectName: string | null
  task: OrderTask
  fixLines?: FixLine[]   // lines the "Suggest" column can fix inline (MISSING_SKU / MISSING_BASE_COST)
}

export async function listOrderTasks(filter: { projectId?: string } = {}): Promise<{
  rows: TaskRow[]
  counts: Record<TaskType, number>
}> {
  const orders = await prisma.order.findMany({
    where: { ...ACTIVE_WHERE, ...(filter.projectId ? { projectId: filter.projectId } : {}) },
    orderBy: { placedAt: 'desc' },
    select: {
      id: true, shopifyOrderNumber: true, placedAt: true, orderType: true, designReady: true,
      project: { select: { name: true } },
      lines: {
        select: {
          id: true, sku: true, productTitle: true, shopifyProductType: true, shopifyVariantId: true,
          resolvedSupplierId: true, resolvedBaseCost: true, manualBaseCost: true,
        },
      },
    },
  })

  const rows: TaskRow[] = []
  const counts = {} as Record<TaskType, number>
  for (const o of orders) {
    const productLines = o.lines.filter(l => !isNonProductLine(l))
    const tasks = detectOrderTasks({ orderType: o.orderType, designReady: o.designReady, lines: o.lines })
    for (const task of tasks) {
      let fixLines: FixLine[] | undefined
      if (task.type === 'MISSING_SKU') {
        fixLines = productLines.filter(l => !l.sku || !l.sku.trim())
          .map(l => ({ lineId: l.id, shopifyVariantId: l.shopifyVariantId, productTitle: l.productTitle, sku: l.sku }))
      } else if (task.type === 'MISSING_BASE_COST') {
        fixLines = productLines.filter(l => l.resolvedSupplierId && l.resolvedBaseCost == null && l.manualBaseCost == null)
          .map(l => ({ lineId: l.id, shopifyVariantId: l.shopifyVariantId, productTitle: l.productTitle, sku: l.sku }))
      }
      rows.push({
        orderId: o.id,
        shopifyOrderNumber: o.shopifyOrderNumber,
        placedAt: o.placedAt,
        projectName: o.project?.name ?? null,
        task,
        fixLines,
      })
      counts[task.type] = (counts[task.type] ?? 0) + 1
    }
  }
  return { rows, counts }
}

// Backfill missing SKUs on one order from the current variant sku on Shopify,
// then return the order's remaining tasks. Downstream resolution (mapping/design)
// is left to the sync/normalize crons per the design.
export async function recheckOrderTasks(
  orderId: string,
  fetchVariantSkus: (variantIds: string[]) => Promise<Map<string, string | null>>,
): Promise<{ remaining: OrderTask[]; skuBackfilled: number }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      orderType: true, designReady: true,
      lines: {
        select: {
          id: true, sku: true, shopifyVariantId: true, productTitle: true, shopifyProductType: true,
          resolvedSupplierId: true, resolvedBaseCost: true, manualBaseCost: true,
        },
      },
    },
  })
  if (!order) throw new Error('Order not found')

  const needSku = order.lines.filter(l => (!l.sku || !l.sku.trim()) && l.shopifyVariantId)
  let skuBackfilled = 0
  if (needSku.length > 0) {
    const skuByVariant = await fetchVariantSkus(needSku.map(l => l.shopifyVariantId!) as string[])
    for (const l of needSku) {
      const sku = skuByVariant.get(l.shopifyVariantId!)
      if (sku) {
        await prisma.orderLine.update({ where: { id: l.id }, data: { sku } })
        l.sku = sku
        skuBackfilled++
      }
    }
  }

  const remaining = detectOrderTasks({ orderType: order.orderType, designReady: order.designReady, lines: order.lines })
  return { remaining, skuBackfilled }
}
