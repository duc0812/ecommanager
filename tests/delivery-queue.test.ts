import { describe, it, expect, vi, afterEach } from 'vitest'
import { runSerial, memoryPressure } from '@/lib/delivery/queue'

afterEach(() => { vi.useRealTimers() })

describe('runSerial', () => {
  it('runs three jobs in order with at least the gap between the end of one and the start of the next', async () => {
    vi.useFakeTimers()
    const starts: number[] = []
    const order: number[] = []
    const job = (i: number) => async () => {
      starts.push(Date.now())
      order.push(i)
      await new Promise(r => setTimeout(r, 50))
      return i
    }
    const ps = [runSerial(job(1)), runSerial(job(2)), runSerial(job(3))]
    await vi.advanceTimersByTimeAsync(2000)
    expect(await Promise.all(ps)).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(350)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(350)
  })

  it('a rejected job does not stop the next one', async () => {
    vi.useFakeTimers()
    const bad = runSerial(async () => { throw new Error('boom') })
    const bad2 = expect(bad).rejects.toThrow('boom')
    const good = runSerial(async () => 'ok')
    await vi.advanceTimersByTimeAsync(2000)
    await bad2
    expect(await good).toBe('ok')
  })
})

describe('memoryPressure', () => {
  it('flags high rss', () => expect(memoryPressure({ rss: 1200e6, free: 2e9 })).toEqual({ retryAfterSec: 60 }))
  it('flags low free memory', () => expect(memoryPressure({ rss: 500e6, free: 500e6 })).not.toBeNull())
  it('is null when both are healthy', () => expect(memoryPressure({ rss: 500e6, free: 2e9 })).toBeNull())
})
