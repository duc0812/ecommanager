import { prisma } from '@/lib/db'
import { detectOrderTasks, type OrderTask, type TaskType } from '@/lib/order-tasks'
import { isNonProductLine } from '@/lib/order-lines'

const ACTIVE_WHERE = { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } }

export type FixLine = { lineId: string; shopifyVariantId: string | null; productTitle: string; sku: string | null }

export type TaskRow = {
  orderId: string
  shopifyOrderNumber: string
  placedAt: Date
  projectId: string | null
  projectName: string | null
  task: OrderTask
  fixLines?: FixLine[]   // lines the "Suggest" column can fix inline (MISSING_SKU / MISSING_BASE_COST)
}

export type DoneTaskRow = {
  orderId: string
  shopifyOrderNumber: string
  taskType: TaskType
  dept: string
  resolvedAt: Date
  projectId: string | null
  projectName: string | null
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
      fulfillmentStatus: true, pipelineStatus: true,
      projectId: true,
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
    const tasks = detectOrderTasks({
      orderType: o.orderType, designReady: o.designReady, lines: o.lines,
      placedAt: o.placedAt, fulfillmentStatus: o.fulfillmentStatus, pipelineStatus: o.pipelineStatus,
    })
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
        projectId: o.projectId ?? null,
        projectName: o.project?.name ?? null,
        task,
        fixLines,
      })
      counts[task.type] = (counts[task.type] ?? 0) + 1
    }
  }
  return { rows, counts }
}

// Reconcile the persisted OrderTaskState against the current live open tasks
// (computed across ALL projects — never a project-filtered subset, or tasks in
// other projects would be wrongly marked resolved). Open tasks are upserted
// with resolvedAt=null (re-opening any that had previously resolved); persisted
// open states no longer present in the live set are stamped resolvedAt=now.
export async function reconcileTaskStates(openRows: TaskRow[]): Promise<void> {
  const now = new Date()
  const openKeys = new Set(openRows.map(r => `${r.orderId}::${r.task.type}`))

  for (const r of openRows) {
    await prisma.orderTaskState.upsert({
      where: { orderId_taskType: { orderId: r.orderId, taskType: r.task.type } },
      create: {
        orderId: r.orderId,
        shopifyOrderNumber: r.shopifyOrderNumber,
        taskType: r.task.type,
        dept: r.task.dept,
        resolvedAt: null,
      },
      update: {
        shopifyOrderNumber: r.shopifyOrderNumber,
        dept: r.task.dept,
        resolvedAt: null,
      },
    })
  }

  const persistedOpen = await prisma.orderTaskState.findMany({ where: { resolvedAt: null } })
  const toResolve = persistedOpen.filter(s => !openKeys.has(`${s.orderId}::${s.taskType}`))
  if (toResolve.length > 0) {
    await prisma.orderTaskState.updateMany({
      where: { id: { in: toResolve.map(s => s.id) } },
      data: { resolvedAt: now },
    })
  }
}

export async function listDoneTasks(filter: { projectId?: string } = {}): Promise<DoneTaskRow[]> {
  const states = await prisma.orderTaskState.findMany({
    where: { resolvedAt: { not: null } },
    orderBy: { resolvedAt: 'desc' },
    take: 500,
  })
  if (states.length === 0) return []

  const orders = await prisma.order.findMany({
    where: { id: { in: Array.from(new Set(states.map(s => s.orderId))) } },
    select: { id: true, projectId: true, project: { select: { name: true } } },
  })
  const projById = new Map(orders.map(o => [o.id, { projectId: o.projectId ?? null, projectName: o.project?.name ?? null }]))

  return states
    .map(s => {
      const p = projById.get(s.orderId)
      return {
        orderId: s.orderId,
        shopifyOrderNumber: s.shopifyOrderNumber,
        taskType: s.taskType as TaskType,
        dept: s.dept,
        resolvedAt: s.resolvedAt as Date,
        projectId: p?.projectId ?? null,
        projectName: p?.projectName ?? null,
      }
    })
    .filter(r => !filter.projectId || r.projectId === filter.projectId)
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
      orderType: true, designReady: true, placedAt: true, fulfillmentStatus: true, pipelineStatus: true,
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

  const remaining = detectOrderTasks({
    orderType: order.orderType, designReady: order.designReady, lines: order.lines,
    placedAt: order.placedAt, fulfillmentStatus: order.fulfillmentStatus, pipelineStatus: order.pipelineStatus,
  })
  return { remaining, skuBackfilled }
}
