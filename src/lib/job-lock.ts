type LockState = { running: Map<string, number> }

declare global {
  // eslint-disable-next-line no-var
  var __jobLocks: LockState | undefined
}

function state(): LockState {
  if (!globalThis.__jobLocks) globalThis.__jobLocks = { running: new Map() }
  return globalThis.__jobLocks
}

export function isJobRunning(name: string): boolean {
  return state().running.has(name)
}

export function jobStartedAt(name: string): number | null {
  return state().running.get(name) ?? null
}

// Runs `fn` unless a job with the same name is already in flight in this process.
// Returns { skipped: true } when it was skipped, so schedulers can log instead of
// stacking overlapping runs. State lives on globalThis so every bundle copy of a
// module (Next.js emits several) shares the same lock table.
export async function runExclusive<T>(name: string, fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const s = state()
  if (s.running.has(name)) return { skipped: true }
  s.running.set(name, Date.now())
  try {
    const result = await fn()
    return { skipped: false, result }
  } finally {
    s.running.delete(name)
  }
}

// One-time initialisation guard that survives multiple bundle copies and HMR.
export function initOnce(key: string): boolean {
  const g = globalThis as typeof globalThis & { __initOnce?: Set<string> }
  if (!g.__initOnce) g.__initOnce = new Set()
  if (g.__initOnce.has(key)) return false
  g.__initOnce.add(key)
  return true
}
