import { prisma } from '@/lib/db'
import { designOf } from '@/lib/flat-text-coverage'
import { isLineExported } from '@/lib/line-export'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'

export type AffectedRow = {
  taskKey: string
  orderNumber: string
  placedAt: string
  taskStatus: string | null
  sent: boolean
  sameSupplierSku: boolean
}

export type AffectedList = { rows: AffectedRow[]; fulfilledCount: number }

type FixedLine = { orderId: string; shopifyLineId: string; supplierSku: string | null }

const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']

export async function listDesignLines(designCode: string, storeId: string, fixed: FixedLine): Promise<AffectedList> {
  if (!designCode.trim()) return { rows: [], fulfilledCount: 0 }
  const orders = await prisma.order.findMany({
    where: { storeId, lines: { some: { sku: { contains: designCode } } } },
    include: { lines: true, designTasks: true },
  })
  const rows: AffectedRow[] = []
  let fulfilledCount = 0
  for (const order of orders) {
    if (CLOSED_PIPELINE.includes(order.pipelineStatus) || CLOSED_FINANCIAL.includes(order.financialStatus.toUpperCase())) continue
    const fulfilled = order.pipelineStatus === 'FULFILLED' || (order.fulfillmentStatus ?? '').toLowerCase() === 'fulfilled'
    const keys = lineKeysOf(order.shopifyOrderNumber, order.lines)
    for (const line of order.lines) {
      if (isNonProductLine(line) || designOf(line.sku) !== designCode) continue
      if (order.id === fixed.orderId && line.shopifyLineId === fixed.shopifyLineId) continue
      const task = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
      if (task?.status === 'CANCELLED') continue
      if (fulfilled) { fulfilledCount++; continue }
      const taskKey = task?.taskKey ?? keys.get(line.shopifyLineId)
      if (!taskKey) continue
      rows.push({
        taskKey,
        orderNumber: order.shopifyOrderNumber,
        placedAt: order.placedAt.toISOString(),
        taskStatus: task?.status ?? null,
        sent: isLineExported(order, line),
        sameSupplierSku: fixed.supplierSku != null && line.resolvedSupplierSku === fixed.supplierSku,
      })
    }
  }
  rows.sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.taskKey.localeCompare(b.taskKey))
  return { rows, fulfilledCount }
}

export async function affectedForTask(taskId: string): Promise<AffectedList & { designCode: string | null }> {
  const task = await prisma.designTask.findUnique({ where: { id: taskId }, include: { order: { include: { lines: true } } } })
  if (!task) return { rows: [], fulfilledCount: 0, designCode: null }
  const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
  const designCode = line ? designOf(line.sku) || null : null
  if (!line || !designCode) return { rows: [], fulfilledCount: 0, designCode }
  const list = await listDesignLines(designCode, task.order.storeId, {
    orderId: task.orderId, shopifyLineId: task.shopifyLineId, supplierSku: line.resolvedSupplierSku,
  })
  return { ...list, designCode }
}

export async function findLineByKey(key: string): Promise<{ lineId: string; orderId: string; shopifyLineId: string } | null> {
  const cut = key.lastIndexOf('_')
  if (cut <= 0) return null
  const orderNo = key.slice(0, cut)
  const orders = await prisma.order.findMany({
    where: { shopifyOrderNumber: { in: [`#${orderNo}`, orderNo] } },
    include: { lines: true },
  })
  for (const order of orders) {
    const keys = lineKeysOf(order.shopifyOrderNumber, order.lines)
    const line = order.lines.find(l => keys.get(l.shopifyLineId) === key)
    if (line) return { lineId: line.id, orderId: order.id, shopifyLineId: line.shopifyLineId }
  }
  return null
}
