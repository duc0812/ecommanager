import { prisma } from '@/lib/db'
import { exportedSupplierOf } from '@/lib/line-export'
import { supplierFixNoticeText } from '@/lib/design-agent/notify'
import { resolveTaskRefs } from '@/lib/lark/resolve'
import { replyAmbiguous } from '@/lib/lark/replies'

/**
 * "noti LIT6262_1 LIT6270_2": the owner's own notice for a sent line whose design has to be updated (owner 11/20/2026).
 * The bot answers in the group with the same line the approval sends, one per code, and moves nothing on the tool:
 * the line may not even be reopened yet. Read without an AI call.
 */
const COMMAND = /^(?:b[aá]o\s+)?(?:noti|notify|notification)\b[\s:,.-]*(.*)$/i
const KEY = /#?(?:[A-Za-z]+\d+|\d{4,})(?:_\d+)?/g

export const REPLY_NOTICE_NO_KEY = 'Nhắn kèm mã đơn cần báo, ví dụ: noti LIT6262_1.'
export const noticeNotSent = (key: string) => `${key}: dòng chưa gửi xưởng, không báo.`
export const noticeUnknown = (ref: string) => `${ref}: không tìm thấy dòng này trên tool.`

export function parseNoticeCommand(text: string): string[] | null {
  const m = COMMAND.exec(text.trim())
  if (!m) return null
  return Array.from(new Set((m[1].match(KEY) ?? []).map(k => k.replace(/^#/, '').toUpperCase())))
}

const ORDER_SELECT = {
  pipelineStatus: true, exportedAt: true, exportedToSupplierId: true,
  lines: { select: { id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, exportedAt: true, exportedToSupplierId: true } },
} as const

export async function larkNoticeReply(keys: string[], text: string): Promise<string[]> {
  if (keys.length === 0) return [REPLY_NOTICE_NO_KEY]
  const refs = await resolveTaskRefs(keys, text)
  const lines: string[] = []
  for (const task of refs.tasks) {
    if (!task.sent) { lines.push(noticeNotSent(task.taskKey)); continue }
    const line = await prisma.orderLine.findUnique({ where: { id: task.lineId }, select: { shopifyLineId: true, order: { select: ORDER_SELECT } } })
    const row = line?.order.lines.find(l => l.shopifyLineId === line.shopifyLineId)
    const supplierId = line && row ? (exportedSupplierOf(line.order, row) ?? row.resolvedSupplierId) : null
    const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }) : null
    lines.push(supplierFixNoticeText(task.taskKey, supplier?.name ?? 'xưởng', 'LINK'))
  }
  for (const a of refs.ambiguous) lines.push(replyAmbiguous(a.ref, a.candidates))
  for (const u of refs.unknown) lines.push(noticeUnknown(u))
  return lines
}
