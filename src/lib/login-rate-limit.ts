const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

type Bucket = { count: number; resetAt: number }

declare global {
  // eslint-disable-next-line no-var
  var __loginAttempts: Map<string, Bucket> | undefined
}

function store() {
  if (!globalThis.__loginAttempts) globalThis.__loginAttempts = new Map()
  return globalThis.__loginAttempts
}

function prune(now: number) {
  const s = store()
  if (s.size < 500) return
  s.forEach((bucket, key) => { if (bucket.resetAt <= now) s.delete(key) })
}

export function loginBlocked(key: string, now = Date.now()) {
  const bucket = store().get(key)
  if (!bucket || bucket.resetAt <= now) return false
  return bucket.count >= MAX_ATTEMPTS
}

export function recordLoginFailure(key: string, now = Date.now()) {
  prune(now)
  const s = store()
  const bucket = s.get(key)
  if (!bucket || bucket.resetAt <= now) {
    s.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }
  bucket.count += 1
}

export function clearLoginFailures(key: string) {
  store().delete(key)
}

export function clientIp(headers: Headers) {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
}
