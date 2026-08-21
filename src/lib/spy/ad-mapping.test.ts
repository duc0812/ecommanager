import { describe, it, expect } from 'vitest'
import { mapApifyAd } from './ad-mapping'

describe('mapApifyAd', () => {
  it('maps core fields, unix dates, advertiser info, video mediaType', () => {
    const raw = {
      ad_archive_id: 'A1', page_id: '123', page_name: 'Brand', is_active: true,
      start_date: 1735689600, end_date: 1736294400, collation_count: 5, collation_id: 'c1',
      currency: 'USD', ad_library_url: 'https://facebook.com/ads/library/?id=A1',
      publisher_platform: ['facebook', 'instagram'],
      advertiser: { ad_library_page_info: { page_info: { likes: 1000, page_category: 'Retail', ig_username: 'brand', ig_followers: 50 } } },
      snapshot: { display_format: 'video', videos: [{ video_hd_url: 'v' }], body: { text: 'Buy now' }, caption: 'cap', cta_type: 'SHOP_NOW', cta_text: 'Shop Now', link_url: 'https://shop', title: 'T' },
    }
    const a = mapApifyAd(raw)
    expect(a.adArchiveId).toBe('A1')
    expect(a.pageId).toBe('123')
    expect(a.pageLikes).toBe(1000)
    expect(a.igUsername).toBe('brand')
    expect(a.isActive).toBe(true)
    expect(a.startDate?.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(a.mediaType).toBe('video')
    expect(a.body).toBe('Buy now')
    expect(a.ctaType).toBe('SHOP_NOW')
    expect(a.publisherPlatforms).toEqual(['facebook', 'instagram'])
  })

  it('detects carousel when cards>1 and handles string body + missing dates', () => {
    const a = mapApifyAd({ ad_archive_id: 'A2', page_id: '9', is_active: false, snapshot: { cards: [{}, {}], body: 'plain' } })
    expect(a.mediaType).toBe('carousel')
    expect(a.body).toBe('plain')
    expect(a.startDate).toBeNull()
    expect(a.pageLikes).toBeNull()
  })
})
