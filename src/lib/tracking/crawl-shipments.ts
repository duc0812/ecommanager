import { prisma } from '@/lib/db'
import { crawlParcelsApp, type ParcelsappResult } from './crawl-parcelsapp'
import { buildInternalTrackingSnapshot, parseInternalTrackingSnapshot } from './tracking-status'

export type CrawlScope = 'all' | 'undelivered'

export type CrawlRunResult = {
  scope: CrawlScope
  shipmentsMatched: number
  numbersCrawled: number
  updated: number
  withEvents: number
  byStatus: Record<string, number>
  errors: string[]
}

const TERMINAL_STATUSES = ['DELIVERED', 'EXPIRED']

// Crawl delivery status through parcelsapp (universal, resolves China-line
// last-mile handoffs). Results are persisted per tracking number as they arrive
// so an interrupted run keeps everything crawled so far. `limit` caps a run to
// the most recent N shipments so a single pass doesn't take hours.
export async function crawlShipmentStatuses(scope: CrawlScope, limit?: number): Promise<CrawlRunResult> {
  const rows = await prisma.shipment.findMany({
    where: { trackingNumber: { not: null } },
    orderBy: [{ order: { placedAt: 'desc' } }],
    select: { id: true, trackingNumber: true, checkpointsJson: true },
  })
  const inScope = scope === 'all'
    ? rows
    : rows.filter(row => !TERMINAL_STATUSES.includes(parseInternalTrackingSnapshot(row.checkpointsJson)?.status ?? ''))
  const shipments = limit && limit > 0 ? inScope.slice(0, limit) : inScope

  const result: CrawlRunResult = {
    scope, shipmentsMatched: shipments.length, numbersCrawled: 0,
    updated: 0, withEvents: 0, byStatus: {}, errors: [],
  }
  if (shipments.length === 0) return result

  // A tracking number can be shared by several sub-order shipments — crawl once, apply to all.
  const shipmentsByNumber = new Map<string, typeof shipments>()
  for (const s of shipments) {
    const key = s.trackingNumber as string
    const list = shipmentsByNumber.get(key) ?? []
    list.push(s)
    shipmentsByNumber.set(key, list)
  }
  const numbers = Array.from(shipmentsByNumber.keys())

  const persistOne = async (num: string, r: ParcelsappResult) => {
    result.numbersCrawled++
    const targets = shipmentsByNumber.get(num) ?? []
    const now = new Date()
    if (!r.ok) {
      await prisma.shipment.updateMany({
        where: { id: { in: targets.map(t => t.id) } },
        data: { crawlSource: 'parcelsapp', crawlError: r.error ?? 'crawl failed', crawledAt: now },
      })
      return
    }
    const hasEvents = r.checkpoints.length > 0
    if (hasEvents) result.withEvents++
    for (const s of targets) {
      // Never downgrade a shipment already known delivered when a re-crawl finds nothing new.
      const prevStatus = parseInternalTrackingSnapshot(s.checkpointsJson)?.status ?? null
      const status = (!hasEvents && prevStatus && TERMINAL_STATUSES.includes(prevStatus)) ? prevStatus : r.status
      await prisma.shipment.update({
        where: { id: s.id },
        data: {
          status,
          detectedCarrier: r.carrierChain.length > 0 ? r.carrierChain.join(' → ') : null,
          lastMileCarrier: r.lastMileCarrier,
          lastMileTrackingNumber: r.lastMileTrackingNumber,
          checkpointsJson: JSON.stringify(buildInternalTrackingSnapshot(status, r.checkpoints)),
          lastCheckpointAt: r.lastCheckpointAt,
          crawlSource: 'parcelsapp',
          crawlError: null,
          crawledAt: now,
        },
      })
      result.updated++
      result.byStatus[status] = (result.byStatus[status] ?? 0) + 1
    }
  }

  await crawlParcelsApp(numbers, persistOne)
  return result
}
