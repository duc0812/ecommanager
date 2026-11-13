import { prisma } from '@/lib/db'
import { isNonProductLine, lineKeysOf } from '@/lib/order-lines'
import { detectLastMileCarrier } from '@/lib/tracking/lastmile-carrier'
import { SHIPMENT_STATUS_PENDING } from '@/lib/tracking/build-shipments'
import type { OrderRow } from '@/lib/fulfillment/build-fulfill-plan'
import { VnepacketError, getTracking, lineReferences, orderReferences, shipmentStatusOf, type VnepacketSession, type VnepacketTracking } from '@/lib/vnepacket'
import { getVnepacketSettings, hasVnepacketAccount, vnepacketSession } from '@/lib/vnepacket-settings'

/**
 * The suppliers whose parcels go out on the shop's VNEpacket account: prod "Gỗ 3D VN" (code 3) and "Litzzy Inhouse";
 * apiType "vnepacket" adds any other.
 */
export const VNEPACKET_SUPPLIER_CODES = ['3', 'litzzy_inhouse']
export const VNEPACKET_API_TYPE = 'vnepacket'
const TRACKING_WINDOW_DAYS = 90
const PAUSE_MS = 250
const CLOSED_PIPELINE = ['CANCELLED', 'REFUNDED']
// A parcel the HPW warehouse checked in has left the supplier; a label alone has not.
const SHIPPED_STATUSES = ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function findVnepacketSuppliers() {
  return prisma.supplier.findMany({
    where: { OR: [{ code: { in: VNEPACKET_SUPPLIER_CODES } }, { apiType: VNEPACKET_API_TYPE }] },
    select: { id: true, name: true, code: true },
  })
}

export type VnepacketLineResult = { lineKey: string; reference: string | null; trackingNumber: string | null; status: string | null; written: boolean }

export type VnepacketSyncResult = { pushes: number; found: number; shipments: number; skipped?: string; lines?: VnepacketLineResult[]; errors?: string[] }

export function checkpointsOf(t: VnepacketTracking) {
  return [...t.events]
    .sort((a, b) => b.time.localeCompare(a.time))
    .map(e => ({ time: e.time || null, desc: e.location ? `${e.desc} — ${e.location}` : e.desc, status: null }))
}

function eventDate(time: string | null): Date | null {
  if (!time) return null
  const d = new Date(time.includes('T') ? time : time.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

type SyncLine = { id: string; shopifyLineId: string; sku: string | null; productTitle: string | null; exportedToSupplierId: string | null }

/**
 * Writes a VNEpacket parcel on the line's Shipment. A row Shopify already fulfilled under another number keeps it:
 * only its own parcel's status is refreshed, and a mismatch is left for a person.
 */
async function writeShipment(order: { id: string; projectId: string }, line: SyncLine, lineKey: string, supplierId: string, t: VnepacketTracking): Promise<boolean> {
  if (!t.trackingNumber) return false
  const checkpoints = checkpointsOf(t)
  const crawl = {
    status: shipmentStatusOf(t),
    lastMileCarrier: t.carrier ?? detectLastMileCarrier(t.trackingNumber).company,
    lastMileTrackingNumber: t.trackingNumber,
    checkpointsJson: checkpoints.length > 0 ? JSON.stringify(checkpoints) : null,
    lastCheckpointAt: eventDate(checkpoints[0]?.time ?? null),
    crawlSource: 'vnepacket',
    crawlError: null,
    crawledAt: new Date(),
  }
  const carrier = t.carrier ?? detectLastMileCarrier(t.trackingNumber).company
  const existing = await prisma.shipment.findUnique({ where: { orderId_lineKey: { orderId: order.id, lineKey } } })
  if (!existing) {
    await prisma.shipment.create({
      data: {
        orderId: order.id, projectId: order.projectId, lineKey, shopifyLineId: line.shopifyLineId, sku: line.sku, productTitle: line.productTitle,
        supplierId, trackingNumber: t.trackingNumber, carrier, ...crawl,
      },
    })
    return true
  }
  if (existing.trackingNumber && existing.trackingNumber !== t.trackingNumber && (existing.shopifyFulfillmentId || existing.supplierId !== supplierId)) {
    console.warn(`[vnepacket] ${lineKey}: VNEpacket parcel ${t.trackingNumber} differs from the stored ${existing.trackingNumber} — left for a person`)
    return false
  }
  await prisma.shipment.update({
    where: { id: existing.id },
    data: {
      trackingNumber: t.trackingNumber, carrier: existing.carrier ?? carrier, supplierId,
      ...(existing.shopifyLineId === line.shopifyLineId ? {} : { shopifyLineId: line.shopifyLineId, sku: line.sku, productTitle: line.productTitle }),
      ...crawl,
      ...(existing.status !== SHIPMENT_STATUS_PENDING && crawl.status === 'PENDING' ? { status: existing.status } : {}),
    },
  })
  return true
}

/** The first of these references VNEpacket knows. */
export async function findLineTracking(session: VnepacketSession, references: string[]): Promise<VnepacketTracking | null> {
  for (const ref of references) {
    const { tracking } = await getTracking(session, ref)
    if (tracking && (tracking.trackingNumber || tracking.events.length > 0)) return tracking
    await sleep(PAUSE_MS)
  }
  return null
}

/**
 * Tracking of every line sent to a VNEpacket supplier that has not been delivered: the parcel is looked up by the line key
 * the supplier sheet uses, and lands on the line's Shipment (number, status, checkpoints).
 */
export async function syncVnepacketTracking(opts: { orderNumber?: string; withLines?: boolean } = {}): Promise<VnepacketSyncResult> {
  const suppliers = await findVnepacketSuppliers()
  if (suppliers.length === 0) return { pushes: 0, found: 0, shipments: 0, skipped: 'no VNEpacket supplier (Gỗ 3D / In House)' }
  const settings = await getVnepacketSettings()
  if (!hasVnepacketAccount(settings)) return { pushes: 0, found: 0, shipments: 0, skipped: 'no VNEpacket account' }
  const supplierIds = suppliers.map(s => s.id)
  const since = new Date(Date.now() - TRACKING_WINDOW_DAYS * 24 * 3600 * 1000)
  const orderNumber = opts.orderNumber?.trim().replace(/^#/, '')
  const orders = await prisma.order.findMany({
    where: {
      ...(orderNumber
        ? { shopifyOrderNumber: { in: [orderNumber, `#${orderNumber}`] } }
        : { pipelineStatus: { notIn: CLOSED_PIPELINE }, lines: { some: { exportedToSupplierId: { in: supplierIds }, exportedAt: { gte: since } } } }),
    },
    select: {
      id: true, projectId: true, shopifyOrderNumber: true,
      lines: { orderBy: { linePosition: 'asc' }, select: { id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, linePosition: true, exportedToSupplierId: true } },
      shipments: { select: { lineKey: true, status: true, crawlSource: true } },
    },
  })
  const session = vnepacketSession(settings)
  const lines: VnepacketLineResult[] = []
  const errors: string[] = []
  let checked = 0
  let found = 0
  let written = 0
  let failedInARow = 0
  let stop = false
  for (const order of orders) {
    if (stop) break
    const keys = lineKeysOf(order.shopifyOrderNumber, order.lines)
    const sent = order.lines.filter(l => !isNonProductLine(l) && !!l.exportedToSupplierId && supplierIds.includes(l.exportedToSupplierId) && keys.has(l.shopifyLineId))
    const delivered = (key: string) => order.shipments.some(s => s.lineKey === key && s.status === 'DELIVERED' && s.crawlSource === 'vnepacket')
    const open = sent.filter(l => orderNumber || !delivered(keys.get(l.shopifyLineId) as string))
    if (open.length === 0) continue
    checked += open.length
    try {
      const byLine = new Map<string, VnepacketTracking | null>()
      for (const line of open) byLine.set(line.shopifyLineId, await findLineTracking(session, lineReferences(keys.get(line.shopifyLineId) as string)))
      // A parcel under the bare order number holds the whole order (In House packs it so): only when no line has a parcel of
      // its own, nothing was delivered apart, and one supplier made every line — two suppliers' parcels cannot share one number.
      const wholeOrder = open.length === sent.length && new Set(sent.map(l => l.exportedToSupplierId)).size === 1 && Array.from(byLine.values()).every(t => !t)
        ? await findLineTracking(session, orderReferences(order.shopifyOrderNumber))
        : null
      for (const line of open) {
        const lineKey = keys.get(line.shopifyLineId) as string
        const t = byLine.get(line.shopifyLineId) ?? wholeOrder
        if (t) found++
        const ok = t ? await writeShipment(order, line, lineKey, line.exportedToSupplierId as string, t) : false
        if (ok) written++
        lines.push({ lineKey, reference: t?.reference ?? null, trackingNumber: t?.trackingNumber ?? null, status: t ? shipmentStatusOf(t) : null, written: ok })
      }
      failedInARow = 0
    } catch (e: any) {
      errors.push(`${order.shopifyOrderNumber.replace(/^#/, '')}: ${e?.message ?? e}`)
      // A refused login, or VNEpacket down three orders running, would fail every other order the same way.
      failedInARow++
      if ((e instanceof VnepacketError && (e.authFailed || (e.status === 0 && !e.noResponse))) || failedInARow >= 3) stop = true
    }
  }
  if (errors.length > 0) console.error(`[vnepacket] ${errors.length} line(s) failed: ${errors.slice(0, 5).join('; ')}`)
  return { pushes: checked, found, shipments: written, ...(opts.withLines ? { lines } : {}), ...(errors.length > 0 ? { errors: errors.slice(0, 20) } : {}) }
}

/**
 * Auto Fulfilled rows from VNEpacket: one per line that went to a VNEpacket supplier and whose parcel VNEpacket shows on its way, not yet
 * fulfilled on Shopify. Like an API push, the row is already tied to the supplier the line was sent to, and already shipped.
 */
export async function vnepacketShipmentRows(storeId: string): Promise<Map<string, OrderRow[]>> {
  const out = new Map<string, OrderRow[]>()
  const supplierIds = (await findVnepacketSuppliers()).map(s => s.id)
  if (supplierIds.length === 0) return out
  const rows = await prisma.shipment.findMany({
    where: {
      crawlSource: 'vnepacket', supplierId: { in: supplierIds }, trackingNumber: { not: null }, shopifyFulfillmentId: null,
      status: { in: SHIPPED_STATUSES }, order: { storeId, pipelineStatus: { notIn: CLOSED_PIPELINE } },
    },
    select: {
      lineKey: true, trackingNumber: true, supplierId: true, shopifyLineId: true,
      order: { select: { shopifyOrderNumber: true, lines: { select: { shopifyLineId: true, exportedToSupplierId: true } } } },
    },
  })
  for (const r of rows) {
    const tracking = r.trackingNumber?.trim()
    const line = r.order.lines.find(l => l.shopifyLineId === r.shopifyLineId)
    if (!tracking || !line || line.exportedToSupplierId !== r.supplierId) continue
    const base = r.order.shopifyOrderNumber.replace(/^#/, '')
    out.set(base, [...(out.get(base) ?? []), { lineKey: r.lineKey, tracking }])
  }
  return out
}
