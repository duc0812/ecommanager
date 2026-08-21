import { prisma } from '@/lib/db'
import { parseAdLink } from './ad-link'

export async function recentLaunchSet(linkUrls: Array<string | null>, windowDays = 7): Promise<Set<string>> {
  const parsed = linkUrls.map(parseAdLink).filter(p => p.kind === 'product' && p.host && p.handle)
  const hosts = Array.from(new Set(parsed.map(p => p.host as string)))
  const handles = Array.from(new Set(parsed.map(p => p.handle as string)))
  if (hosts.length === 0 || handles.length === 0) return new Set()
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const products = await prisma.spyProduct.findMany({
    where: { handle: { in: handles }, firstSeenAt: { gte: since }, store: { domain: { in: hosts } } },
    select: { handle: true, store: { select: { domain: true } } },
  })
  return new Set(products.map(p => `${p.store?.domain}|${p.handle}`))
}
