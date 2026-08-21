import { prisma } from '@/lib/db'
import { startActorRun, pollRunUntilDone, getDatasetItems } from './apify'
import { mapApifyAd } from './ad-mapping'
import { ingestAds } from './ingest-ads'
import { AD_SCAN_CAP } from './ad-signals'

export async function runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string }) {
  const scan = await prisma.spyScan.create({
    data: { type: 'STORE_ADS', targetType: 'STORE', targetId: pageTarget.storeId ?? pageTarget.id, status: 'running' },
  })
  try {
    const { runId, datasetId } = await startActorRun({
      urls: [{ url: pageTarget.pageUrl }],
      'scrapePageAds.activeStatus': 'all',
      'scrapePageAds.sortBy': 'impressions_desc',
      'scrapePageAds.countryCode': 'ALL',
      count: AD_SCAN_CAP,
    })
    await prisma.spyScan.update({ where: { id: scan.id }, data: { apifyRunId: runId, apifyDatasetId: datasetId } })
    await pollRunUntilDone(runId)
    const items = await getDatasetItems(datasetId)
    const ads = items.map(mapApifyAd)
    const ingest = await ingestAds(scan.id, pageTarget.storeId, ads)
    const stats = { totalScanned: items.length, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    const fbPageId = ads.find(a => a.pageId)?.pageId ?? null
    await prisma.spyPageTarget.update({ where: { id: pageTarget.id }, data: { lastScanAt: new Date(), ...(fbPageId ? { fbPageId } : {}) } })
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
