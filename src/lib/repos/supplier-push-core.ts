import { prisma } from '@/lib/db'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { requiredSlotsFor, templateForLine } from '@/lib/design-tasks'
import { artworkUrl } from '@/lib/design-studio'
import { currentFiles, extraPrintParts, sameLabel } from '@/lib/task-files'
import { logHandoffEvent } from '@/lib/repos/push-export'
import { retryOnBusy } from '@/lib/sqlite-busy'
import { SHIPMENT_STATUS_FULFILLED, SHIPMENT_STATUS_PENDING } from '@/lib/tracking/build-shipments'
import { ensurePublicToken, publicArtworkUrl } from '@/lib/public-artwork'
import { expectedSize, printFileFit } from '@/lib/print-file-fit'
import { PushError } from '@/lib/repos/pgprints-push'
import type { DesignArtwork } from '@/generated/prisma/client'
import type { PreviewFile, PushStatus, PushView } from '@/lib/pgprints-shared'

export const ACTIVE_STATUSES: PushStatus[] = ['SENDING', 'CREATED']
export const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
export const CLOSED_FINANCIAL = ['REFUNDED', 'VOIDED']
export const EXPORT_READY = ['READY_TO_PRODUCTION', 'EXPORTED']
export const UNKNOWN_RESULT_GRACE_MS = 2 * 60_000

export type PushRow = Awaited<ReturnType<typeof prisma.supplierOrderPush.findUniqueOrThrow>>

export const isActive = (status: string) => (ACTIVE_STATUSES as string[]).includes(status)
export const activeKeyFor = (orderId: string, supplierId: string) => `${orderId}::${supplierId}`

export function httpsUrl(v: string | null | undefined): string | null {
  if (!v) return null
  try { return new URL(v).protocol === 'https:' ? v : null } catch { return null }
}

export function isUniqueViolation(e: any): boolean {
  if (e?.code === 'P2002') return true
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`
  return msg.includes('UNIQUE constraint failed') || msg.includes('Unique constraint failed')
}

export async function toPushViews(rows: PushRow[]): Promise<PushView[]> {
  const userIds = Array.from(new Set(rows.map(r => r.pushedById).filter((x): x is string => !!x)))
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))
  return rows.map(r => ({
    id: r.id, status: r.status as PushStatus, externalOrderId: r.externalOrderId, supplierOrderCode: r.supplierOrderCode,
    remoteStatus: r.remoteStatus, totalCost: r.totalCost, shippingFee: r.shippingFee, handleFee: r.handleFee, error: r.error,
    pushedAt: r.pushedAt.toISOString(), pushedByName: r.pushedById ? (nameById.get(r.pushedById) ?? null) : null,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null, lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
  }))
}

export async function viewOf(pushId: string): Promise<PushView> {
  const row = await prisma.supplierOrderPush.findUniqueOrThrow({ where: { id: pushId } })
  return (await toPushViews([row]))[0]
}

/** Takes the one live slot of an order × supplier before anything is sent, so two clicks can never make two orders. */
export async function reservePush(
  input: { orderId: string; supplierId: string; externalOrderId: string; requestJson: string; userId: string | null },
  duplicateMessage: string,
): Promise<{ id: string; pushedAt: Date }> {
  const activeKey = activeKeyFor(input.orderId, input.supplierId)
  const pushedAt = new Date()
  try {
    return await retryOnBusy(() => prisma.$transaction(async tx => {
      const existing = await tx.supplierOrderPush.findMany({ where: { orderId: input.orderId, supplierId: input.supplierId } })
      if (existing.some(p => isActive(p.status))) throw new PushError(duplicateMessage, 409, 'DUPLICATE')
      const fresh = {
        status: 'SENDING', activeKey, requestJson: input.requestJson, responseJson: null, error: null,
        supplierOrderCode: null, supplierInternalId: null, remoteStatus: null, totalCost: null, shippingFee: null, handleFee: null,
        pushedById: input.userId, pushedAt, cancelledAt: null, lastSyncedAt: null, exportMarked: false, prevExportJson: null,
      }
      const failed = existing.find(p => p.status === 'FAILED' && p.externalOrderId === input.externalOrderId)
      if (failed) {
        const r = await tx.supplierOrderPush.updateMany({ where: { id: failed.id, status: 'FAILED' }, data: fresh })
        if (r.count !== 1) throw new PushError(duplicateMessage, 409, 'DUPLICATE')
        return { id: failed.id, pushedAt }
      }
      const row = await tx.supplierOrderPush.create({
        data: { orderId: input.orderId, supplierId: input.supplierId, externalOrderId: input.externalOrderId, ...fresh },
      })
      return { id: row.id, pushedAt }
    }))
  } catch (e: any) {
    if (e instanceof PushError) throw e
    if (isUniqueViolation(e)) throw new PushError(duplicateMessage, 409, 'DUPLICATE')
    throw e
  }
}

export async function latestPush(orderId: string, supplierId: string, statuses: PushStatus[]): Promise<PushRow | null> {
  return prisma.supplierOrderPush.findFirst({ where: { orderId, supplierId, status: { in: statuses } }, orderBy: { createdAt: 'desc' } })
}

/** Marks a live push cancelled and puts the order back as it was before the push marked it. Returns whether the export marks were undone. */
export async function closeCancelledPush(push: PushRow, eventMessage: string): Promise<boolean> {
  const orderId = push.orderId
  const r = await prisma.supplierOrderPush.updateMany({
    where: { id: push.id, status: 'CREATED' },
    data: { status: 'CANCELLED', activeKey: null, cancelledAt: new Date() },
  })
  if (r.count !== 1 || !push.exportMarked) return false
  let prev: {
    pipelineStatus?: string; exportedAt?: string | null; exportedToSupplierId?: string | null
    supplierHandoffAt?: string | null; supplierHandoffMode?: string | null; supplierHandoffById?: string | null
  } = {}
  try { prev = JSON.parse(push.prevExportJson ?? '{}') } catch {}
  const reverted = await prisma.order.updateMany({
    where: { id: orderId, pipelineStatus: 'EXPORTED', exportedToSupplierId: push.supplierId, exportedAt: push.pushedAt },
    data: {
      pipelineStatus: prev.pipelineStatus ?? 'READY_TO_PRODUCTION',
      exportedAt: prev.exportedAt ? new Date(prev.exportedAt) : null,
      exportedToSupplierId: prev.exportedToSupplierId ?? null,
      supplierHandoffAt: prev.supplierHandoffAt ? new Date(prev.supplierHandoffAt) : null,
      supplierHandoffMode: prev.supplierHandoffAt ? (prev.supplierHandoffMode ?? null) : null,
      supplierHandoffById: prev.supplierHandoffAt ? (prev.supplierHandoffById ?? null) : null,
    },
  })
  const stillExported = reverted.count === 0 && (await prisma.order.count({ where: { id: orderId, pipelineStatus: 'EXPORTED' } })) > 0
  const lines = stillExported ? { count: 0 } : await prisma.orderLine.updateMany({
    where: { orderId, exportedToSupplierId: push.supplierId, exportedAt: push.pushedAt },
    data: { exportedAt: null, exportedToSupplierId: null },
  })
  const exportReverted = reverted.count === 1 || lines.count > 0
  if (exportReverted) await logHandoffEvent(orderId, eventMessage, null)
  return exportReverted
}

type TrackedLine = { shopifyLineId: string; resolvedSupplierId: string | null; resolvedSupplierSku: string | null }

/** Writes a tracking number on the Shipment of each of this supplier's lines; `pick` returns null for a line with none yet. */
export async function upsertLineTracking(
  push: Pick<PushRow, 'orderId' | 'supplierId'>,
  pick: (line: TrackedLine) => { number: string; company: string | null } | null,
): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: push.orderId },
    select: {
      id: true, projectId: true, shopifyOrderNumber: true,
      lines: { orderBy: { linePosition: 'asc' }, select: { shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true, resolvedSupplierId: true, resolvedSupplierSku: true } },
    },
  })
  if (!order) return 0
  const productLines = order.lines.filter(l => !isNonProductLine(l))
  const lineKeys = lineKeysOf(order.shopifyOrderNumber, order.lines)
  let touched = 0
  for (const line of productLines) {
    if (line.resolvedSupplierId !== push.supplierId) continue
    const t = pick(line)
    if (!t) continue
    const lineKey = lineKeys.get(line.shopifyLineId)!
    const existing = await prisma.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } } })
    if (!existing) {
      await prisma.shipment.create({
        data: {
          orderId: order.id, projectId: order.projectId, lineKey, shopifyLineId: line.shopifyLineId, sku: line.sku, productTitle: line.productTitle,
          supplierId: push.supplierId, trackingNumber: t.number, carrier: t.company, status: SHIPMENT_STATUS_FULFILLED,
        },
      })
      touched++
      continue
    }
    if (existing.shopifyFulfillmentId && existing.trackingNumber) continue
    if (existing.trackingNumber === t.number && existing.status !== SHIPMENT_STATUS_PENDING) continue
    await prisma.shipment.update({
      where: { id: existing.id },
      data: {
        trackingNumber: t.number, carrier: t.company ?? existing.carrier, supplierId: existing.supplierId ?? push.supplierId,
        ...(existing.status === SHIPMENT_STATUS_PENDING ? { status: SHIPMENT_STATUS_FULFILLED } : {}),
      },
    })
    touched++
  }
  return touched
}

type PushLine = Parameters<typeof templateForLine>[0] & {
  shopifyLineId: string; previewCdnUrl: string | null; imageUrl: string | null
}
type Report = { error: (code: string, message: string, refId?: string) => void; warning: (code: string, message: string, refId?: string) => void }

export type LineFiles = {
  /** Print parts in template order, each with the link the supplier downloads. */
  prints: Array<{ area: string; publicUrl: string | null }>
  files: PreviewFile[]
  templateName: string | null
  /** What the supplier gets as the product image: the newest mockup file, else the Shopify image. */
  image: string | null
  /** What the preview window shows for it. */
  mockupUrl: string | null
}

/** The print and mockup files of one line, with the checks every API supplier needs. The links are only made for an approved line. */
export async function collectLineFiles(
  line: PushLine, artworks: DesignArtwork[], ctx: { refId: string; approved: boolean; baseUrl: string | null; supplierName: string }, report: Report,
): Promise<LineFiles> {
  const { refId, approved, baseUrl, supplierName } = ctx
  const template = await templateForLine(line)
  const slots = requiredSlotsFor(template)
  const lineFiles = artworks.filter(a => a.shopifyLineId === line.shopifyLineId)
  const current = currentFiles(lineFiles, 'PRINT')
  const parts = [...slots, ...extraPrintParts(lineFiles, slots)]
  if (parts.length === 0) report.error('NO_ARTWORK', `${refId}: chưa có file in nào`, refId)
  const files: PreviewFile[] = []
  const prints: LineFiles['prints'] = []
  for (const area of parts) {
    const art = current.find(a => sameLabel(a.printArea, area)) ?? null
    const target = slots.includes(area) ? expectedSize(template, area) : null
    if (!art) {
      report.error('NO_ARTWORK', `${refId}: chưa có file in cho vùng "${area}"`, refId)
      files.push({
        area, artworkId: null, fileName: null, mimeType: null, widthPx: null, heightPx: null,
        expectedWidthPx: target?.w ?? null, expectedHeightPx: target?.h ?? null, sizeOk: null, publicUrl: null, viewUrl: null, thumbUrl: null,
      })
      continue
    }
    if (art.mimeType !== 'image/png' && art.mimeType !== 'image/jpeg') {
      report.error('FILE_TYPE', `${refId}: file "${area}" (${art.fileName}) không phải PNG/JPEG — ${supplierName} chỉ nhận link ảnh PNG hoặc JPEG`, refId)
    }
    const fit = slots.includes(area) ? printFileFit(template, area, art) : null
    const sizeOk = fit?.state === 'ok' ? true : fit?.state === 'bad' ? false : null
    if (!template) report.warning('NO_TEMPLATE', `${refId}: SKU xưởng chưa gán template in — không đối chiếu được kích thước file`, refId)
    else if (sizeOk === false) report.warning('SIZE_MISMATCH', `${refId}: file "${area}" ${art.widthPx}×${art.heightPx}px khác khổ template ${target!.w}×${target!.h}px`, refId)
    const publicUrl = baseUrl && approved ? publicArtworkUrl(baseUrl, await ensurePublicToken(art.id), art) : null
    prints.push({ area, publicUrl })
    files.push({
      area, artworkId: art.id, fileName: art.fileName, mimeType: art.mimeType, widthPx: art.widthPx, heightPx: art.heightPx,
      expectedWidthPx: target?.w ?? null, expectedHeightPx: target?.h ?? null, sizeOk, publicUrl,
      viewUrl: artworkUrl(art.id), thumbUrl: art.previewPath ? `${artworkUrl(art.id)}?preview=1` : artworkUrl(art.id),
    })
  }

  const mockups = currentFiles(lineFiles, 'MOCKUP')
    .filter(a => a.mimeType === 'image/png' || a.mimeType === 'image/jpeg')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  let image: string | null = null
  if (baseUrl && approved && mockups[0]) image = httpsUrl(publicArtworkUrl(baseUrl, await ensurePublicToken(mockups[0].id), mockups[0]))
  image = image ?? httpsUrl(line.previewCdnUrl ?? line.imageUrl)
  return { prints, files, templateName: template?.name ?? null, image, mockupUrl: mockups[0] ? artworkUrl(mockups[0].id) : image }
}
