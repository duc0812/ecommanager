import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: any = { advUpsert: [], adUpsert: [], obs: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyAdvertiser: { upsert: vi.fn(async (a: any) => { calls.advUpsert.push(a); return { id: 'adv1' } }) },
    spyAd: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async (a: any) => { calls.adUpsert.push(a); return { id: 'ad1' } }),
    },
    spyAdObservation: { upsert: vi.fn(async (a: any) => { calls.obs.push(a); return {} }) },
  },
}))

import { ingestAds } from './ingest-ads'
import type { ParsedSpyAd } from '@/lib/spy/ad-mapping'

const ad = (id: string): ParsedSpyAd => ({
  adArchiveId: id, pageId: '123', pageName: 'Brand', pageCategory: 'Retail', pageLikes: 10,
  igUsername: null, igFollowers: null, isActive: true, startDate: new Date('2026-08-01'),
  endDate: null, collationCount: 3, collationId: 'c', mediaType: 'video', displayFormat: 'video',
  mediaUrl: 'https://thumb.jpg',
  ctaType: 'SHOP_NOW', ctaText: 'Shop', linkUrl: 'https://x', title: 'T', body: 'B', caption: null,
  publisherPlatforms: ['facebook'], currency: 'USD', adLibraryUrl: 'https://l', rawPayload: { x: 1 },
})

beforeEach(() => { calls.advUpsert.length = 0; calls.adUpsert.length = 0; calls.obs.length = 0; vi.clearAllMocks() })

describe('ingestAds', () => {
  it('upserts advertiser by fbPageId, ad by adArchiveId, observation per scan', async () => {
    const res = await ingestAds('scan1', 'store1', [ad('A1')])
    expect(res.found).toBe(1)
    expect(calls.advUpsert[0].where).toEqual({ fbPageId: '123' })
    expect(calls.adUpsert[0].where).toEqual({ adArchiveId: 'A1' })
    expect(calls.adUpsert[0].create.publisherPlatforms).toBe('["facebook"]')
    expect(calls.adUpsert[0].create.rawPayload).toBe('{"x":1}')
    expect(calls.obs[0].where).toEqual({ adId_scanId: { adId: 'ad1', scanId: 'scan1' } })
  })

  it('tags advertiser with adDomainId when provided', async () => {
    await ingestAds('scan1', null, [ad('A1')], { adDomainId: 'dom1' })
    expect(calls.advUpsert[0].create.adDomainId).toBe('dom1')
    expect(calls.advUpsert[0].update.adDomainId).toBe('dom1')
  })
})
