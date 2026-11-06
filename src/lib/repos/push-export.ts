import { prisma } from '@/lib/db'
import { markOrdersExported } from '@/lib/repos/orders'
import {
  canSendBeside, isLineExported, needsFileLines, pushFileTokens, pushLineIds, pushShopifyLineIds, pushedShopifyLineIds,
  type ExportTrackedLine, type ExportTrackedOrder, type PushedLine,
} from '@/lib/line-export'
import { isLineApproved } from '@/lib/public-artwork'

export const ACTIVE_PUSH_STATUSES = ['SENDING', 'CREATED']

export type PushRef = { id: string; orderId: string; supplierId: string; pushedAt: Date; pushedById?: string | null }
export type ActivePush = { status: string; supplierOrderCode: string | null; externalOrderId: string; exportMarked: boolean }

export async function logHandoffEvent(orderId: string, message: string, actorId: string | null) {
  const tasks = await prisma.designTask.findMany({ where: { orderId, status: { not: 'CANCELLED' } }, select: { id: true } })
  if (tasks.length === 0) return
  await prisma.designTaskEvent.createMany({ data: tasks.map(t => ({ taskId: t.id, type: actorId ? 'HANDOFF' : 'SYSTEM', message, actorId })) })
}

/**
 * What one send to a supplier carries: its unsent lines with an approved design. The others wait for a later send; with
 * nothing approved the preview shows every unsent line and why it cannot go. A live push that does not hold these lines
 * stays where it is and this send goes beside it (`later`); any other live push keeps today's refusal.
 */
export function planPushLines<L extends ExportTrackedLine & { id: string; shopifyLineId: string; designDriveLink: string | null }>(
  order: ExportTrackedOrder<L> & { designTasks: { shopifyLineId: string; status: string }[] }, own: L[],
  pushes: { supplierId: string; status: string; exportMarked: boolean; prevExportJson: string | null }[],
): { lines: L[]; held: L[]; later: boolean } {
  const unsent = own.filter(l => !isLineExported(order, l))
  const cleared = unsent.filter(l => isLineApproved(l, order.designTasks.find(t => t.shopifyLineId === l.shopifyLineId)))
  const live = pushes.filter(p => ACTIVE_PUSH_STATUSES.includes(p.status))
  const later = live.length > 0 && cleared.length > 0 && canSendBeside(live, cleared)
  if (cleared.length > 0 && (live.length === 0 || later)) return { lines: cleared, held: unsent.filter(l => !cleared.includes(l)), later }
  return { lines: live.length > 0 || unsent.length === 0 ? own : unsent, held: [], later: false }
}

/**
 * The number a new send goes under. A number stays taken on the supplier's side once it was cancelled or is live, and the
 * column is unique across suppliers, so an order going to two API factories gets one each. A refused number is used again.
 */
export async function nextExternalOrderId(
  orderNo: string,
  ctx: { orderId: string; supplierId: string | null; later: boolean; spent?: (p: { status: string; supplierInternalId: string | null }) => boolean },
): Promise<string> {
  for (let n = 1; ; n++) {
    const id = n > 1 ? `${orderNo}-R${n}` : orderNo
    const row = await prisma.supplierOrderPush.findUnique({ where: { externalOrderId: id }, select: { orderId: true, supplierId: true, status: true, supplierInternalId: true } })
    if (!row || row.orderId !== ctx.orderId) return id
    if (row.supplierId !== ctx.supplierId) continue
    if (row.status === 'CANCELLED' || ctx.spent?.(row) || (ctx.later && ACTIVE_PUSH_STATUSES.includes(row.status))) continue
    return id
  }
}

/** A line a send carries, with the ids the build read it under. */
export type PushLineRef = { id: string; shopifyLineId: string }

/** What a new push stores about its lines: the OrderLine ids, and the Shopify line ids that outlive the order sync. */
export function pushLinesJson(lines: PushLineRef[]): string {
  return JSON.stringify({ lineIds: lines.map(l => l.id), shopifyLineIds: lines.map(l => l.shopifyLineId) })
}

export function heldLinesMessage(keys: string[]): string {
  return `Chỉ gửi các dòng đã duyệt; dòng ${keys.join(', ')} còn đang làm design — duyệt xong gửi sau`
}

/** The Shopify lines whose print or mockup files a push sent: each public file link names a DesignArtwork of its order. */
export async function sentFileLines(push: { orderId: string; requestJson: string | null }): Promise<string[]> {
  const tokens = pushFileTokens(push.requestJson)
  if (tokens.length === 0) return []
  const files = await prisma.designArtwork.findMany({ where: { orderId: push.orderId, publicToken: { in: tokens } }, select: { shopifyLineId: true } })
  return Array.from(new Set(files.map(f => f.shopifyLineId)))
}

/** pushedShopifyLineIds, reading the files an older push sent once the order sync has replaced the OrderLine ids it stored. */
export async function carriedShopifyLineIds(
  push: { orderId: string; supplierId: string; prevExportJson: string | null; requestJson?: string | null }, lines: PushedLine[],
): Promise<string[] | null> {
  const fileLines = needsFileLines(push, lines) ? await sentFileLines({ orderId: push.orderId, requestJson: push.requestJson ?? null }) : []
  return pushedShopifyLineIds(push, lines, fileLines)
}

/**
 * The one place a supplier push marks its order: the pushed supplier's lines (exportedAt = pushedAt, which is how a
 * cancel finds them again), Exported + the API handoff once every line is sent, and the state a cancel restores.
 * Only the lines the push carried are marked; a push from before sends went by line carried every line of its supplier.
 * Returns false when nothing was marked (the order is not in an exportable status, or has no line of this supplier).
 */
export async function markPushExported(push: PushRef): Promise<boolean> {
  const stored = await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: push.id }, select: { prevExportJson: true, requestJson: true } })
  const storedLineIds = pushLineIds(stored)
  const storedShopifyLineIds = pushShopifyLineIds(stored)
  const before = await prisma.order.findUnique({
    where: { id: push.orderId },
    select: {
      pipelineStatus: true, exportedAt: true, exportedToSupplierId: true,
      supplierHandoffAt: true, supplierHandoffMode: true, supplierHandoffById: true,
      lines: { select: { id: true, shopifyLineId: true, exportedToSupplierId: true } },
    },
  })
  // The lines it carried as the order has them now: the order sync may have replaced the OrderLine ids the push stored.
  const carried = before ? await carriedShopifyLineIds({ ...push, ...stored }, before.lines) : null
  const lineIds = before && carried ? before.lines.filter(l => carried.includes(l.shopifyLineId)).map(l => l.id) : storedLineIds
  const marked = await markOrdersExported([push.orderId], push.supplierId, push.pushedAt, { mode: 'API', byId: push.pushedById ?? null }, lineIds ? { lineIds } : {})
  if (marked.count === 0 || !before) return false
  await prisma.supplierOrderPush.update({
    where: { id: push.id },
    data: {
      exportMarked: true,
      prevExportJson: JSON.stringify({
        pipelineStatus: before.pipelineStatus,
        exportedAt: before.exportedAt ? before.exportedAt.toISOString() : null,
        exportedToSupplierId: before.exportedToSupplierId,
        supplierHandoffAt: before.supplierHandoffAt ? before.supplierHandoffAt.toISOString() : null,
        supplierHandoffMode: before.supplierHandoffMode,
        supplierHandoffById: before.supplierHandoffById,
        linesMarked: marked.lines,
        ...(storedLineIds ? { lineIds: storedLineIds } : {}),
        ...(storedShopifyLineIds ? { shopifyLineIds: storedShopifyLineIds } : {}),
      }),
    },
  })
  return true
}

export async function activePushByOrder(orderIds: string[]): Promise<Map<string, ActivePush>> {
  const out = new Map<string, ActivePush>()
  if (orderIds.length === 0) return out
  const rows = await prisma.supplierOrderPush.findMany({
    where: { orderId: { in: orderIds }, status: { in: ACTIVE_PUSH_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, status: true, supplierOrderCode: true, externalOrderId: true, exportMarked: true },
  })
  for (const r of rows) {
    if (!out.has(r.orderId)) out.set(r.orderId, { status: r.status, supplierOrderCode: r.supplierOrderCode, externalOrderId: r.externalOrderId, exportMarked: r.exportMarked })
  }
  return out
}

export function reconcileMessage(code: string | null): string {
  return `Đơn đã gửi PGprints từ trước${code ? ` (mã ${code})` : ''} — đánh dấu Exported, không gửi lại`
}

/**
 * An order pushed to the supplier before its design was approved in the app keeps a CREATED push with exportMarked = false.
 * Once the order is fully approved this marks it exactly like a push made here would have, so nobody hands it off twice.
 */
export async function reconcilePushedOrder(orderId: string): Promise<boolean> {
  const push = await prisma.supplierOrderPush.findFirst({
    where: { orderId, status: 'CREATED', exportMarked: false },
    orderBy: { createdAt: 'desc' },
    select: { id: true, orderId: true, supplierId: true, pushedAt: true, pushedById: true, supplierOrderCode: true, externalOrderId: true },
  })
  if (!push) return false
  if (!(await markPushExported(push))) return false
  await logHandoffEvent(orderId, reconcileMessage(push.supplierOrderCode ?? push.externalOrderId), null)
  return true
}
