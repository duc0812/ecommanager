import { prisma } from '@/lib/db'
import type { ParsedSpyAd } from '@/lib/spy/ad-mapping'

export async function ingestAds(
  scanId: string, storeId: string | null, ads: ParsedSpyAd[],
): Promise<{ found: number; newAds: number; updated: number }> {
  let newAds = 0, updated = 0
  const now = new Date()
  for (const a of ads) {
    if (!a.adArchiveId || !a.pageId) continue
    const advertiser = await prisma.spyAdvertiser.upsert({
      where: { fbPageId: a.pageId },
      create: {
        fbPageId: a.pageId, pageName: a.pageName, pageCategory: a.pageCategory,
        likes: a.pageLikes, igUsername: a.igUsername, igFollowers: a.igFollowers,
        storeId: storeId ?? undefined, firstSeenAt: now, lastSeenAt: now,
      },
      update: {
        pageName: a.pageName, pageCategory: a.pageCategory, likes: a.pageLikes,
        igUsername: a.igUsername, igFollowers: a.igFollowers, lastSeenAt: now,
        ...(storeId ? { storeId } : {}),
      },
    })

    const existing = await prisma.spyAd.findUnique({ where: { adArchiveId: a.adArchiveId }, select: { id: true } })
    const data = {
      advertiserId: advertiser.id, pageId: a.pageId, startDate: a.startDate, endDate: a.endDate,
      isActive: a.isActive, collationCount: a.collationCount, collationId: a.collationId,
      mediaType: a.mediaType, mediaUrl: a.mediaUrl, displayFormat: a.displayFormat, ctaType: a.ctaType, ctaText: a.ctaText,
      linkUrl: a.linkUrl, title: a.title, body: a.body, caption: a.caption,
      publisherPlatforms: JSON.stringify(a.publisherPlatforms), currency: a.currency,
      adLibraryUrl: a.adLibraryUrl, rawPayload: JSON.stringify(a.rawPayload),
    }
    const row = await prisma.spyAd.upsert({
      where: { adArchiveId: a.adArchiveId },
      create: { adArchiveId: a.adArchiveId, firstSeenAt: now, lastSeenAt: now, ...data },
      update: { lastSeenAt: now, ...data },
    })
    if (existing) updated++; else newAds++

    await prisma.spyAdObservation.upsert({
      where: { adId_scanId: { adId: row.id, scanId } },
      create: { adId: row.id, scanId, isActive: a.isActive, collationCount: a.collationCount, observedAt: now },
      update: { isActive: a.isActive, collationCount: a.collationCount },
    })
  }
  return { found: ads.length, newAds, updated }
}
