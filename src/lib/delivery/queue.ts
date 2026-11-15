import fs from 'fs'
import os from 'os'

type QueueState = { tail: Promise<unknown>; lastEnd: number }

declare global {
  // eslint-disable-next-line no-var
  var __deliveryQueue: QueueState | undefined
}

const RSS_LIMIT = 1100e6
const FREE_LIMIT = 600e6

function state(): QueueState {
  if (!globalThis.__deliveryQueue) globalThis.__deliveryQueue = { tail: Promise.resolve(), lastEnd: 0 }
  return globalThis.__deliveryQueue
}

// State lives on globalThis so every bundle copy of this module (Next emits several) shares one chain.
export function runSerial<T>(fn: () => Promise<T>, opts: { gapMs?: number } = {}): Promise<T> {
  const gapMs = opts.gapMs ?? 300
  const s = state()
  const run = async () => {
    const wait = s.lastEnd + gapMs - Date.now()
    if (s.lastEnd && wait > 0) await new Promise(r => setTimeout(r, wait))
    try {
      return await fn()
    } finally {
      s.lastEnd = Date.now()
    }
  }
  const next = s.tail.then(run, run)
  s.tail = next.catch(() => {})
  return next
}

type MeminfoReader = () => string | null

const readProcMeminfo: MeminfoReader = () => fs.readFileSync('/proc/meminfo', 'utf8')

// os.freemem() is MemFree on older Node, which leaves out page cache the kernel would hand back; MemAvailable counts it.
export function freeMemory(readMeminfo: MeminfoReader = readProcMeminfo): number {
  let text: string | null = null
  try {
    text = readMeminfo()
  } catch {
    text = null
  }
  const kb = text ? /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1] : undefined
  return kb ? Number(kb) * 1024 : os.freemem()
}

export function memoryPressure(sample?: { rss: number; free: number }, readMeminfo?: MeminfoReader): { retryAfterSec: number } | null {
  const { rss, free } = sample ?? { rss: process.memoryUsage().rss, free: freeMemory(readMeminfo) }
  return rss > RSS_LIMIT || free < FREE_LIMIT ? { retryAfterSec: 60 } : null
}
