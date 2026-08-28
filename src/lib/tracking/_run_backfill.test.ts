import { it, expect } from 'vitest'
import { prisma } from '@/lib/db'
import { crawlShipmentStatuses } from './crawl-shipments'

// Operational harness only. Keep skipped so the normal test suite never crawls or writes runtime data.
it.skip('crawls all internal shipment statuses through headless DOM tracking', async () => {
  const crawl = await crawlShipmentStatuses('all')
  console.log('CRAWL:', JSON.stringify(crawl))

  const statusDist = await prisma.shipment.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('STATUS DIST:', JSON.stringify(statusDist.map(r => ({ status: r.status, count: r._count._all }))))
  const carrierDist = await prisma.shipment.groupBy({ by: ['detectedCarrier'], _count: { _all: true } })
  console.log('CARRIER DIST:', JSON.stringify(carrierDist.map(r => ({ carrier: r.detectedCarrier, count: r._count._all }))))
  const errDist = await prisma.shipment.groupBy({ by: ['crawlError'], _count: { _all: true } })
  console.log('ERROR DIST:', JSON.stringify(errDist.map(r => ({ err: r.crawlError?.slice(0, 60) ?? null, count: r._count._all }))))

  expect(crawl.numbersCrawled).toBeGreaterThan(0)
}, 3600000)
