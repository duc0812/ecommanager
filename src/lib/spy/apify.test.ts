import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const dbToken = { current: null as string | null }
vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      findUnique: vi.fn(async () => (dbToken.current ? { value: dbToken.current } : null)),
    },
  },
}))

import { startActorRun, getRunStatus, pollRunUntilDone } from './apify'

beforeEach(() => { process.env.APIFY_TOKEN = 'tok'; dbToken.current = null })
afterEach(() => { vi.restoreAllMocks() })

describe('apify client', () => {
  it('startActorRun returns runId + datasetId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { id: 'run1', defaultDatasetId: 'ds1' } }),
    } as Response)
    const r = await startActorRun({ urls: [{ url: 'https://facebook.com/x' }] })
    expect(r).toEqual({ runId: 'run1', datasetId: 'ds1' })
  })

  it('throws when no token in DB or env', async () => {
    delete process.env.APIFY_TOKEN
    dbToken.current = null
    await expect(getRunStatus('run1')).rejects.toThrow('APIFY_TOKEN not set')
  })

  it('prefers the DB token over env', async () => {
    dbToken.current = 'dbtok'
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ({ data: { status: 'SUCCEEDED' } }),
    } as Response)
    await getRunStatus('run1')
    expect(String(spy.mock.calls[0][0])).toContain('token=dbtok')
  })

  it('pollRunUntilDone polls until SUCCEEDED', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'RUNNING' } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'SUCCEEDED' } }) } as Response)
    const status = await pollRunUntilDone('run1', { intervalMs: 1, timeoutMs: 1000 })
    expect(status).toBe('SUCCEEDED')
  })

  it('pollRunUntilDone throws on FAILED', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'FAILED' } }) } as Response)
    await expect(pollRunUntilDone('run1', { intervalMs: 1, timeoutMs: 1000 })).rejects.toThrow('FAILED')
  })
})
