import { prisma } from '@/lib/db'
import { parseAdLink } from './ad-link'

export function needsResolution(linkUrl: string | null): boolean {
  if (!linkUrl) return false
  let u: URL
  try { u = new URL(linkUrl) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.pathname === '' || u.pathname === '/') return false
  return parseAdLink(linkUrl).kind === 'other'
}

export async function resolveRedirect(linkUrl: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(linkUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; EcomManagerBot/1.0)' },
    })
    try { await res.body?.cancel() } catch { /* ignore */ }
    return res.url || null
  } catch {
    return null
  }
}

export async function resolvePendingAdLinks(
  opts: { networkCap?: number; batch?: number; concurrency?: number } = {},
): Promise<{ checked: number; resolved: number; network: number }> {
  const networkCap = opts.networkCap ?? 50
  const batch = opts.batch ?? 300
  const concurrency = opts.concurrency ?? 6

  const candidates = await prisma.spyAd.findMany({
    where: { linkResolvedAt: null, linkUrl: { not: null } },
    select: { id: true, linkUrl: true },
    orderBy: { lastSeenAt: 'desc' },
    take: batch,
  })

  const toResolve: { id: string; linkUrl: string }[] = []
  const toMark: string[] = []
  for (const c of candidates) {
    if (c.linkUrl && needsResolution(c.linkUrl)) {
      if (toResolve.length < networkCap) toResolve.push({ id: c.id, linkUrl: c.linkUrl })
    } else {
      toMark.push(c.id)
    }
  }

  if (toMark.length) {
    await prisma.spyAd.updateMany({ where: { id: { in: toMark } }, data: { linkResolvedAt: new Date() } })
  }

  let resolved = 0
  let idx = 0
  async function worker() {
    while (idx < toResolve.length) {
      const cur = toResolve[idx++]
      const finalUrl = await resolveRedirect(cur.linkUrl)
      const good = finalUrl && finalUrl !== cur.linkUrl ? finalUrl : null
      await prisma.spyAd.update({ where: { id: cur.id }, data: { resolvedUrl: good, linkResolvedAt: new Date() } })
      if (good) resolved++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toResolve.length) }, () => worker()))

  return { checked: candidates.length, resolved, network: toResolve.length }
}
