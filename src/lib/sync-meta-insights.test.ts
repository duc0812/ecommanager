import { describe, it, expect, vi, beforeEach } from 'vitest'

const upserts: any[] = []
const campaignUpserts: any[] = []

vi.mock('@/lib/db', () => ({
  prisma: {
    metaAdAccount: {
      findMany: vi.fn(async () => [
        { id: 'acc1', accountId: 'act_123', accountName: 'Test Account', accessToken: 'tok', currency: 'USD' },
      ]),
      update: vi.fn(async () => ({})),
    },
    dailyAdSpend: {
      upsert: vi.fn(async (args: any) => {
        upserts.push(args)
        return {}
      }),
      findFirst: vi.fn(async () => null),
    },
    metaCampaignDailySpend: {
      upsert: vi.fn(async (args: any) => {
        campaignUpserts.push(args)
        return {}
      }),
      findFirst: vi.fn(async () => null),
    },
  },
}))

import { syncMetaInsights, syncMetaCampaignInsights } from '@/lib/sync-meta-insights'

function insightsRow(date: string, spend: string) {
  return { date_start: date, date_stop: date, spend, impressions: '100', clicks: '10' }
}

function campaignRow(date: string, campaignId: string, campaignName: string, spend: string) {
  return { date_start: date, date_stop: date, campaign_id: campaignId, campaign_name: campaignName, spend, impressions: '50', clicks: '5' }
}

describe('syncMetaInsights pagination', () => {
  beforeEach(() => {
    upserts.length = 0
    vi.restoreAllMocks()
  })

  it('follows paging.next so days beyond the first page are not dropped', async () => {
    const page1 = {
      data: Array.from({ length: 25 }, (_, i) => insightsRow(`2026-05-${String(i + 1).padStart(2, '0')}`, '10')),
      paging: { next: 'https://graph.facebook.com/page2' },
    }
    const page2 = {
      data: Array.from({ length: 5 }, (_, i) => insightsRow(`2026-06-0${i + 1}`, '20')),
      paging: {},
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response)

    const result = await syncMetaInsights(30)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][0]).toBe('https://graph.facebook.com/page2')
    expect(result.synced).toBe(30)
    expect(result.errors).toEqual([])
    expect(upserts).toHaveLength(30)
    expect(upserts.at(-1).create.date).toBe('2026-06-05')
  })

  it('reports per-account error when the API call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
    } as Response)

    const result = await syncMetaInsights(30)

    expect(result.synced).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid OAuth access token')
  })
})

describe('syncMetaCampaignInsights', () => {
  beforeEach(() => {
    campaignUpserts.length = 0
    vi.restoreAllMocks()
  })

  it('requests campaign level with campaign fields and upserts one row per campaign per day', async () => {
    const page1 = {
      data: [
        campaignRow('2026-09-01', 'c1', 'Remi04 Pomo New Arrival', '10'),
        campaignRow('2026-09-01', 'c2', 'JEEP mug collection', '4'),
      ],
      paging: { next: 'https://graph.facebook.com/page2' },
    }
    const page2 = { data: [campaignRow('2026-09-02', 'c1', 'Remi04 Pomo New Arrival', '12')], paging: {} }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response)

    const result = await syncMetaCampaignInsights(30)

    const firstUrl = decodeURIComponent(String(fetchSpy.mock.calls[0][0]))
    expect(firstUrl).toContain('level=campaign')
    expect(firstUrl).toContain('fields=campaign_id,campaign_name,spend,impressions,clicks')
    expect(firstUrl).toContain('time_increment=1')
    expect(result.synced).toBe(3)
    expect(result.errors).toEqual([])
    expect(campaignUpserts).toHaveLength(3)
    expect(campaignUpserts[0].where).toEqual({
      adAccountId_campaignId_date: { adAccountId: 'acc1', campaignId: 'c1', date: '2026-09-01' },
    })
    expect(campaignUpserts[0].create).toMatchObject({
      adAccountId: 'acc1', campaignId: 'c1', campaignName: 'Remi04 Pomo New Arrival',
      date: '2026-09-01', spend: 10, impressions: 50, clicks: 5, currency: 'USD',
    })
    expect(campaignUpserts[0].update).toMatchObject({ campaignName: 'Remi04 Pomo New Arrival', spend: 10 })
  })

  it('with no stored campaign rows, first sync since defaults to 180 days back (not 730)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [], paging: {} }),
    } as Response)

    await syncMetaCampaignInsights()

    const expectedSince = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10)
    const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]))
    const timeRange = JSON.parse(firstUrl.searchParams.get('time_range')!)
    expect(timeRange.since).toBe(expectedSince)
  })

  it('skips rows without a campaign_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ date_start: '2026-09-01', spend: '1', impressions: '1', clicks: '0' }], paging: {} }),
    } as Response)

    const result = await syncMetaCampaignInsights(30)

    expect(result.synced).toBe(0)
    expect(campaignUpserts).toHaveLength(0)
  })
})
