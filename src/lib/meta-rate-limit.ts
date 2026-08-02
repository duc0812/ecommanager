const USAGE_KEYS = new Set(['call_count', 'total_cputime', 'total_time', 'acc_id_util_pct'])

function collectUsage(value: unknown, key: string | null, output: number[]) {
  if (typeof value === 'number' && key && USAGE_KEYS.has(key) && Number.isFinite(value)) {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectUsage(item, key, output))
    return
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, child]) => collectUsage(child, childKey, output))
  }
}

export function parseMetaUsagePercent(headers: Pick<Headers, 'get'>) {
  const values: number[] = []
  for (const name of ['x-app-usage', 'x-business-use-case-usage', 'x-ad-account-usage']) {
    const raw = headers.get(name)
    if (!raw) continue
    try {
      collectUsage(JSON.parse(raw), null, values)
    } catch {
      // Ignore malformed usage headers; the request itself can still succeed.
    }
  }
  return values.length > 0 ? Math.max(...values) : null
}

export function metaPageDelayMs(usagePercent: number | null) {
  if (usagePercent === null || usagePercent < 60) return 1_000
  if (usagePercent < 80) return 3_000
  if (usagePercent < 90) return 10_000
  return 30_000
}

export function isMetaRateLimitError(status: number, error: { code?: number; message?: string } | null | undefined) {
  if (status === 429) return true
  if (error?.code && [4, 17, 32, 613, 80004].includes(error.code)) return true
  return /rate.?limit|too many requests|request limit/i.test(error?.message ?? '')
}
