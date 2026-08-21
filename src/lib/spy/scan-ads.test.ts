import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: any = { scans: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyScan: {
      create: vi.fn(async ({ data }: any) => { const s = { id: 'scan1', ...data }; db.scans.push(s); return s }),
      update: vi.fn(async ({ data }: any) => { Object.assign(db.scans[0], data); return db.scans[0] }),
    },
    spyPageTarget: { update: vi.fn(async () => ({})) },
  },
}))
vi.mock('./apify', () => ({
  startActorRun: vi.fn(async () => ({ runId: 'r1', datasetId: 'd1' })),
  pollRunUntilDone: vi.fn(async () => 'SUCCEEDED'),
  getDatasetItems: vi.fn(async () => [{ ad_archive_id: 'A1', page_id: '9', is_active: true }]),
}))
vi.mock('./ingest-ads', () => ({ ingestAds: vi.fn(async () => ({ found: 1, newAds: 1, updated: 0 })) }))

import { runPageAdScan } from './scan-ads'
import { startActorRun, pollRunUntilDone } from './apify'

beforeEach(() => { db.scans.length = 0; vi.clearAllMocks() })

describe('runPageAdScan', () => {
  it('success path records stats and updates page target', async () => {
    const r = await runPageAdScan({ id: 'pt1', storeId: 'store1', pageUrl: 'https://facebook.com/Brand' })
    expect(r.status).toBe('success')
    expect(db.scans[0].status).toBe('success')
    expect((startActorRun as any).mock.calls[0][0].count).toBe(200)
    expect(JSON.parse(db.scans[0].stats)).toMatchObject({ found: 1, newAds: 1 })
  })
  it('failed path when apify run fails', async () => {
    ;(pollRunUntilDone as any).mockRejectedValueOnce(new Error('Apify run FAILED'))
    const r = await runPageAdScan({ id: 'pt1', storeId: null, pageUrl: 'https://facebook.com/Brand' })
    expect(r.status).toBe('failed')
    expect(db.scans[0].status).toBe('failed')
    expect(db.scans[0].error).toContain('FAILED')
  })
})
