import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'os'
import { runSerial, memoryPressure, freeMemory } from '@/lib/delivery/queue'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); globalThis.__deliveryQueue = undefined })

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

describe('freeMemory', () => {
  const MEMINFO = 'MemTotal:        3900000 kB\nMemFree:          100000 kB\nMemAvailable:    1500000 kB\nBuffers:           20000 kB\n'

  it('reads MemAvailable from /proc/meminfo, not MemFree', () => {
    expect(freeMemory(() => MEMINFO)).toBe(1500000 * 1024)
  })

  it('falls back to os.freemem() when meminfo is unreadable or has no MemAvailable', () => {
    vi.spyOn(os, 'freemem').mockReturnValue(4242)
    expect(freeMemory(() => null)).toBe(4242)
    expect(freeMemory(() => { throw new Error('ENOENT') })).toBe(4242)
    expect(freeMemory(() => 'MemTotal: 1 kB\nMemFree: 2 kB\n')).toBe(4242)
  })

  it('memoryPressure without a sample uses the injected reader', () => {
    expect(memoryPressure(undefined, () => 'MemAvailable: 100000 kB\n')).not.toBeNull()
    expect(memoryPressure(undefined, () => 'MemAvailable: 9000000 kB\n')).toBeNull()
  })
})
