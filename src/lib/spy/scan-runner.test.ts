import { describe, it, expect, vi, beforeEach } from 'vitest'

const db: any = { scans: [] }
vi.mock('@/lib/db', () => ({
  prisma: {
    spyScan: {
      create: vi.fn(async ({ data }: any) => { const s = { id: 'scan1', ...data }; db.scans.push(s); return s }),
      update: vi.fn(async ({ data }: any) => { Object.assign(db.scans[0], data); return db.scans[0] }),
    },
  },
}))
vi.mock('./scan-products', () => ({ fetchStoreProducts: vi.fn() }))
vi.mock('./ingest-products', () => ({ ingestStoreProducts: vi.fn() }))

import { runStoreProductScan } from './scan-runner'
import { fetchStoreProducts } from './scan-products'
import { ingestStoreProducts } from './ingest-products'

beforeEach(() => { db.scans.length = 0; vi.clearAllMocks() })

describe('runStoreProductScan', () => {
  it('marks scan success and records stats', async () => {
    ;(fetchStoreProducts as any).mockResolvedValue({ products: [{}, {}], totalScanned: 2 })
    ;(ingestStoreProducts as any).mockResolvedValue({ found: 2, created: 1, updated: 1 })
    const r = await runStoreProductScan({ id: 'store1', domain: 'foo.com' })
    expect(r.status).toBe('success')
    expect(db.scans[0].status).toBe('success')
    expect(JSON.parse(db.scans[0].stats)).toMatchObject({ found: 2, created: 1 })
  })
  it('marks scan failed on fetch error', async () => {
    ;(fetchStoreProducts as any).mockRejectedValue(new Error('boom'))
    const r = await runStoreProductScan({ id: 'store1', domain: 'foo.com' })
    expect(r.status).toBe('failed')
    expect(db.scans[0].status).toBe('failed')
    expect(db.scans[0].error).toBe('boom')
  })
})
