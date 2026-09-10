import { prisma } from '@/lib/db'
import { startActorRun, pollRunUntilDone, getDatasetItems } from './apify'
import { mapApifyAd } from './ad-mapping'
import { ingestAds } from './ingest-ads'
import { resolvePendingAdLinks } from './resolve-link'
import { cacheAdMediaForIds } from './media-cache'
import { AD_SCAN_CAP } from './ad-signals'
import { buildAdLibrarySearchUrl } from './ad-search-url'
import { fanpageUrlFromId } from './fb-url'

type ScanOutcome =
  | { scanId: string; status: 'success'; stats: Record<string, unknown> }
  | { scanId: string; status: 'failed'; error: string }

async function markFailed(scanId: string, e: unknown): Promise<ScanOutcome> {
  const error = e instanceof Error ? e.message : 'Unknown error'
  try {
    await prisma.spyScan.update({ where: { id: scanId }, data: { status: 'failed', error, finishedAt: new Date() } })
  } catch (updateErr) {
    console.error('[spy] could not mark scan failed', scanId, updateErr, 'original error:', error)
  }
  return { scanId, status: 'failed', error }
}

// Shared tail of every ad scan: ingest, mark the scan successful, then run the
// slow post-processing (link resolution, media download) off the critical path so
// the scan row does not sit in "running" for minutes after its data is saved.
async function finalizeAdScan(scanId: string, storeId: string | null, items: any[], adDomainId: string | null | undefined) {
  const ads = items.map(mapApifyAd)
  const ingest = await ingestAds(scanId, storeId, ads, { adDomainId: adDomainId ?? undefined })
  const stats = { totalScanned: items.length, found: ingest.found, newAds: ingest.newAds, updated: ingest.updated }
  await prisma.spyScan.update({ where: { id: scanId }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
  void resolvePendingAdLinks().catch(err => console.error('[spy] link resolve failed', err))
  void cacheAdMediaForIds(ingest.ids).catch(err => console.error('[spy] media cache failed', err))
  return { ads, stats }
}

export async function runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string; adDomainId?: string | null }): Promise<ScanOutcome> {
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
    const items = await getDatasetItems(datasetId, { maxItems: AD_SCAN_CAP })
    const { ads, stats } = await finalizeAdScan(scan.id, pageTarget.storeId, items, pageTarget.adDomainId)
    const fbPageId = ads.find(a => a.pageId)?.pageId ?? null
    await prisma.spyPageTarget.update({ where: { id: pageTarget.id }, data: { lastScanAt: new Date(), ...(fbPageId ? { fbPageId } : {}) } })
    return { scanId: scan.id, status: 'success', stats }
  } catch (e: unknown) {
    return markFailed(scan.id, e)
  }
}

export async function runDomainAdScan(domain: { id: string; searchTerm: string; country: string }): Promise<ScanOutcome> {
  const scan = await prisma.spyScan.create({
    data: { type: 'DOMAIN_ADS', targetType: 'DOMAIN', targetId: domain.id, status: 'running' },
  })
  try {
    const { runId, datasetId } = await startActorRun({
      urls: [{ url: buildAdLibrarySearchUrl(domain.searchTerm, domain.country) }],
      count: AD_SCAN_CAP,
    })
    await prisma.spyScan.update({ where: { id: scan.id }, data: { apifyRunId: runId, apifyDatasetId: datasetId } })
    await pollRunUntilDone(runId)
    const items = await getDatasetItems(datasetId, { maxItems: AD_SCAN_CAP })
    const { stats } = await finalizeAdScan(scan.id, null, items, domain.id)
    await prisma.spyAdDomain.update({ where: { id: domain.id }, data: { lastScanAt: new Date() } })
    // Advertisers discovered through a search term are only candidates: they are
    // recorded as INACTIVE page targets so the daily cron does not start paying for
    // a full Apify run per unrelated fanpage until someone opts a page in.
    const advertisers = await prisma.spyAdvertiser.findMany({ where: { adDomainId: domain.id }, select: { fbPageId: true, pageName: true } })
    for (const adv of advertisers) {
      const pageUrl = fanpageUrlFromId(adv.fbPageId)
      await prisma.spyPageTarget.upsert({
        where: { pageUrl },
        create: { pageUrl, fbPageId: adv.fbPageId, label: adv.pageName ?? undefined, adDomainId: domain.id, active: false },
        update: { adDomainId: domain.id, ...(adv.pageName ? { label: adv.pageName } : {}) },
      })
    }
    return { scanId: scan.id, status: 'success', stats }
  } catch (e: unknown) {
    return markFailed(scan.id, e)
  }
}
