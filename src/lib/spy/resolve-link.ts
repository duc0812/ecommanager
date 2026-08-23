import { prisma } from '@/lib/db'
import { parseAdLink } from './ad-link'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const DEAD = new Set([400, 401, 403, 404, 405, 410, 451])

export type ResolveResult = { status: 'ok'; url: string } | { status: 'dead' } | { status: 'retry' }

export function needsResolution(linkUrl: string | null): boolean {
  if (!linkUrl) return false
  let u: URL
  try { u = new URL(linkUrl) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.pathname === '' || u.pathname === '/') return false
  return parseAdLink(linkUrl).kind === 'other'
}

export async function resolveRedirect(linkUrl: string, timeoutMs = 8000): Promise<ResolveResult> {
  try {
    const res = await fetch(linkUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA },
    })
    try { await res.body?.cancel() } catch { /* ignore */ }
    if (res.ok) return { status: 'ok', url: res.url || linkUrl }
    if (DEAD.has(res.status)) return { status: 'dead' }
    return { status: 'retry' }
  } catch {
    return { status: 'retry' }
  }
}

export async function resolvePendingAdLinks(
  opts: { networkCap?: number; batch?: number; concurrency?: number } = {},
): Promise<{ checked: number; resolved: number; network: number; retried: number }> {
  const networkCap = opts.networkCap ?? 50
  const batch = opts.batch ?? 300
  const concurrency = opts.concurrency ?? 4

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
  let retried = 0
  let idx = 0
  async function worker() {
    while (idx < toResolve.length) {
      const cur = toResolve[idx++]
      const r = await resolveRedirect(cur.linkUrl)
      if (r.status === 'retry') { retried++; continue }
      if (r.status === 'dead') { await prisma.spyAd.update({ where: { id: cur.id }, data: { linkResolvedAt: new Date() } }); continue }
      const good = r.url !== cur.linkUrl ? r.url : null
      await prisma.spyAd.update({ where: { id: cur.id }, data: { resolvedUrl: good, linkResolvedAt: new Date() } })
      if (good) resolved++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toResolve.length) }, () => worker()))

  return { checked: candidates.length, resolved, network: toResolve.length, retried }
}
