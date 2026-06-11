import { describe, it, expect, vi, beforeEach } from 'vitest'

const upserts: any[] = []

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
    },
  },
}))

import { syncMetaInsights } from '@/lib/sync-meta-insights'

function insightsRow(date: string, spend: string) {
  return { date_start: date, date_stop: date, spend, impressions: '100', clicks: '10' }
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
