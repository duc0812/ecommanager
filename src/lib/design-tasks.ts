import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { parseAttributes, sourcePrintFiles } from '@/lib/design-studio'
import { getDesignSettings, kpiForProductType } from '@/lib/design-settings'

export type TaskStatus = 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW' | 'REJECTED' | 'ASK_CUSTOMER' | 'DONE' | 'CANCELLED'
export type Readiness = 'AUTO' | 'LOW' | 'MANUAL'
export type ActorRole = 'LEADER' | 'DESIGNER'
export const TASK_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER', 'DONE', 'CANCELLED']
const OPEN: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']

export function taskKeyFor(orderNumber: string, linePosition: number): string {
  return `${orderNumber.replace(/^#/, '')}_${linePosition}`
}

export function isLeader(role: string): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorRole, readiness: Readiness): boolean {
  if (from === to) return false
  if (from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN.includes(from)
  if (to === 'CANCELLED') return actor === 'LEADER'
  switch (to) {
    case 'ASSIGNED': return actor === 'LEADER' && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return actor === 'LEADER' ? from === 'REVIEW' : (readiness === 'AUTO' && (from === 'NEW' || from === 'ASSIGNED' || from === 'DOING' || from === 'REVIEW'))
    case 'REJECTED': return actor === 'LEADER' && from === 'REVIEW'
    default: return false
  }
}

function readinessFor(customAttributesJson: string | null): Readiness {
  return sourcePrintFiles(parseAttributes(customAttributesJson)).length > 0 ? 'LOW' : 'MANUAL'
}

export async function syncDesignTasks(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, designTasks: true } })
  if (!order) return { created: 0, cancelled: 0, completed: 0 }
  const settings = await getDesignSettings()
  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  const orderClosed = ['CANCELLED', 'REFUNDED'].includes(order.pipelineStatus)
  let created = 0, cancelled = 0, completed = 0

  for (const line of order.lines) {
    if (isNonProductLine(line) || !line.resolvedSupplierId) continue
    const existing = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
    if (orderClosed) {
      if (existing && existing.status !== 'CANCELLED' && existing.status !== 'DONE') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'CANCELLED', events: { create: { type: 'SYSTEM', message: 'Đơn huỷ — task tự huỷ' } } } })
        cancelled++
      }
      continue
    }
    if (line.designDriveLink) {
      if (existing && existing.status !== 'DONE' && existing.status !== 'CANCELLED') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'DONE', events: { create: { type: 'SYSTEM', message: 'Design có từ ngoài studio (Trello / Library) — task done outside' } } } })
        completed++
      }
      continue
    }
    if (existing) continue
    const slaHours = line.customized ? settings.slaCustomHours : settings.slaNonCustomHours
    await prisma.designTask.create({ data: {
      orderId, shopifyLineId: line.shopifyLineId, taskKey: taskKeyFor(order.shopifyOrderNumber, line.linePosition),
      status: 'NEW', readiness: readinessFor(line.customAttributesJson), kpi: kpiForProductType(settings, line.shopifyProductType),
      slaHours, dueAt: new Date(order.placedAt.getTime() + slaHours * 3600_000), supplierSnapshot: supplierName.get(line.resolvedSupplierId) ?? null,
      events: { create: { type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' } },
    } })
    created++
  }
  return { created, cancelled, completed }
}
