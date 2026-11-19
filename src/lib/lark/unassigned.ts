import { prisma } from '@/lib/db'
import type { TaskStatus } from '@/lib/design-tasks'
import { isLineExported, isOrderClosed } from '@/lib/line-export'
import { mappingStates, type MappingStateLine } from '@/lib/mapping-state'
import type { AgentTaskState } from '@/lib/design-agent/delivery'
import { readWorkBoard } from '@/lib/design-agent/work-board'
import { workStatesFor } from '@/lib/design-agent/work-state'
import { REPLY_BOARD_STALE_REPORT } from '@/lib/lark/replies'

export const REPORT_KEYS_PER_GROUP = 20
const WAITING: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
const GROUPS = ['Chưa mapping', 'Thiếu template', 'Làm tay', 'Cần làm artwork'] as const
type Group = (typeof GROUPS)[number]

const LINE_SELECT = {
  id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, shopifyProductId: true,
  resolvedSupplierId: true, resolvedSupplierSku: true, exportedAt: true, exportedToSupplierId: true,
} as const

function groupLine(title: Group, keys: string[]): string {
  const shown = keys.slice(0, REPORT_KEYS_PER_GROUP).join(', ')
  const rest = keys.length - REPORT_KEYS_PER_GROUP
  return `${title} (${keys.length}): ${shown}${rest > 0 ? ` và ${rest} dòng khác` : ''}.`
}

export async function larkUnassignedReport(now: Date = new Date()): Promise<string> {
  if (!(await readWorkBoard([], now)).fresh) return REPLY_BOARD_STALE_REPORT

  const rows = await prisma.designTask.findMany({
    where: { status: { in: WAITING } },
    select: {
      id: true, taskKey: true, status: true, readiness: true, dueAt: true, orderId: true, shopifyLineId: true,
      order: { select: {
        storeId: true, shopifyOrderNumber: true, pipelineStatus: true, financialStatus: true, fulfillmentStatus: true,
        exportedAt: true, exportedToSupplierId: true, lines: { select: LINE_SELECT },
      } },
    },
  })
  const open = rows.flatMap(task => {
    const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    if (!line || isOrderClosed(task.order) || isLineExported(task.order, line)) return []
    return [{ task, line }]
  })
  const states = await workStatesFor(open.map(({ task, line }): AgentTaskState => ({
    taskId: task.id, taskKey: task.taskKey, status: task.status as TaskStatus, sent: false, orderOpen: true,
    lineId: line.id, orderId: task.orderId, orderNumber: task.order.shopifyOrderNumber,
  })), now)
  // A line whose holder cannot be told (the board went stale meanwhile) is never reported as free.
  if (Array.from(states.values()).some(s => s.kind === 'UNKNOWN')) return REPLY_BOARD_STALE_REPORT
  const free = open.filter(({ task }) => states.get(task.taskKey)?.kind === 'FREE')
  if (free.length === 0) return 'Hiện không có dòng nào chưa có người làm.'

  const verdicts = await mappingStates(free.map(({ task, line }): MappingStateLine => ({
    key: task.id, storeId: task.order.storeId, orderId: task.orderId, resolvedSupplierId: line.resolvedSupplierId,
    resolvedSupplierSku: line.resolvedSupplierSku, shopifyProductId: line.shopifyProductId, shopifyProductType: line.shopifyProductType,
  })))
  const due = (d: Date | null) => (d ? d.getTime() : Number.MAX_SAFE_INTEGER)
  const keysOf = new Map<Group, string[]>()
  const sorted = [...free].sort((a, b) => due(a.task.dueAt) - due(b.task.dueAt) || a.task.taskKey.localeCompare(b.task.taskKey, 'en', { numeric: true }))
  for (const { task } of sorted) {
    const mapping = verdicts.get(task.id)?.state
    const group: Group = mapping === 'UNMAPPED' ? 'Chưa mapping'
      : mapping === 'NO_TEMPLATE' ? 'Thiếu template'
        : task.readiness === 'MANUAL' || task.readiness === 'LOW' ? 'Làm tay' : 'Cần làm artwork'
    keysOf.set(group, [...(keysOf.get(group) ?? []), task.taskKey])
  }
  return [
    `Việc chưa có người làm: ${free.length} dòng.`,
    ...GROUPS.filter(g => keysOf.has(g)).map(g => groupLine(g, keysOf.get(g) as string[])),
  ].join('\n')
}
