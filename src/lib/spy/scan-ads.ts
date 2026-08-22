import { prisma } from '@/lib/db'
import { startActorRun, pollRunUntilDone, getDatasetItems } from './apify'
import { mapApifyAd } from './ad-mapping'
import { ingestAds } from './ingest-ads'
import { AD_SCAN_CAP } from './ad-signals'
import { buildAdLibrarySearchUrl } from './ad-search-url'
import { fanpageUrlFromId } from './fb-url'

export async function runPageAdScan(pageTarget: { id: string; storeId: string | null; pageUrl: string; adDomainId?: string | null }) {
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
    const ingest = await ingestAds(scan.id, pageTarget.storeId, ads, { adDomainId: pageTarget.adDomainId ?? undefined })
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

export async function runDomainAdScan(domain: { id: string; searchTerm: string; country: string }) {
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
    const items = await getDatasetItems(datasetId)
    const ads = items.map(mapApifyAd)
    const ingest = await ingestAds(scan.id, null, ads, { adDomainId: domain.id })
    const stats = { totalScanned: items.length, ...ingest }
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'success', stats: JSON.stringify(stats), finishedAt: new Date() } })
    await prisma.spyAdDomain.update({ where: { id: domain.id }, data: { lastScanAt: new Date() } })
    const advertisers = await prisma.spyAdvertiser.findMany({ where: { adDomainId: domain.id }, select: { fbPageId: true, pageName: true } })
    for (const adv of advertisers) {
      const pageUrl = fanpageUrlFromId(adv.fbPageId)
      await prisma.spyPageTarget.upsert({
        where: { pageUrl },
        create: { pageUrl, fbPageId: adv.fbPageId, label: adv.pageName ?? undefined, adDomainId: domain.id },
        update: { adDomainId: domain.id, ...(adv.pageName ? { label: adv.pageName } : {}) },
      })
    }
    return { scanId: scan.id, status: 'success' as const, stats }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : 'Unknown error'
    await prisma.spyScan.update({ where: { id: scan.id }, data: { status: 'failed', error, finishedAt: new Date() } })
    return { scanId: scan.id, status: 'failed' as const, error }
  }
}
