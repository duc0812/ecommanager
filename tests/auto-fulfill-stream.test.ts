import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/fulfillment/auto-fulfill/run/route'

const deps = vi.hoisted(() => ({ pg: vi.fn(), run: vi.fn() }))
vi.mock('@/lib/store-connections', () => ({ listConnectedStores: async () => [{ id: 'test-store' }] }))
vi.mock('@/lib/store-jobs', () => ({ failedResults: () => [], storeRunSummary: () => [] }))
vi.mock('@/lib/fulfillment/auto-fulfill-sheets', () => ({ getSheets: async () => [], getMinAgeDays: async () => 7 }))
vi.mock('@/lib/repos/pgprints-push', () => ({ syncPgprintsTracking: deps.pg }))
vi.mock('@/lib/repos/supplier-tracking-sync', () => ({ syncApiSupplierTracking: async () => [] }))
vi.mock('@/lib/fulfillment/auto-fulfill-stores', () => ({ runAutoFulfillAllStores: deps.run }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('Auto Fulfill while a supplier read is waiting for Retry-After', () => {
  it('keeps the response alive until the work ends and releases its timer', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    deps.pg.mockImplementation(() => new Promise(resolve => { release = resolve }))
    deps.run.mockResolvedValue({ results: [], summary: { rows: [], fulfilled: 0 } })
    const response = await POST(new NextRequest('http://localhost/api/fulfillment/auto-fulfill/run?apply=0', { method: 'POST' }))
    const reader = response.body!.getReader()
    const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value)
    expect(decode((await reader.read()).value)).toContain('"type":"stage"')
    const waiting = reader.read()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(decode((await waiting).value)).toContain('"type":"heartbeat"')
    release({ pushes: 0, found: 0, shipments: 0 })
    let body = ''
    for (;;) { const part = await reader.read(); if (part.done) break; body += decode(part.value) }
    expect(body).toContain('"type":"done"')
    expect(vi.getTimerCount()).toBe(0)
  })
})
