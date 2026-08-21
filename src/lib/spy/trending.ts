export type TrendingNiche = { niche: string; newCount: number; prevCount: number; deltaPct: number; topStores: string[] }

const DAY = 24 * 60 * 60 * 1000

export function computeTrendingNiches(
  products: Array<{ productType: string | null; firstSeenAt: Date; store?: { domain: string } | null }>,
  opts: { windowDays?: number; now?: Date; limit?: number } = {},
): TrendingNiche[] {
  const windowDays = opts.windowDays ?? 7
  const now = (opts.now ?? new Date()).getTime()
  const limit = opts.limit ?? 20
  const curStart = now - windowDays * DAY
  const prevStart = now - 2 * windowDays * DAY

  type Agg = { newCount: number; prevCount: number; stores: Map<string, number> }
  const map = new Map<string, Agg>()

  for (const p of products) {
    const t = p.firstSeenAt.getTime()
    const niche = p.productType || 'Uncategorized'
    let a = map.get(niche)
    if (!a) { a = { newCount: 0, prevCount: 0, stores: new Map() }; map.set(niche, a) }
    if (t >= curStart && t <= now) {
      a.newCount++
      const dom = p.store?.domain
      if (dom) a.stores.set(dom, (a.stores.get(dom) ?? 0) + 1)
    } else if (t >= prevStart && t < curStart) {
      a.prevCount++
    }
  }

  const rows: TrendingNiche[] = []
  for (const [niche, a] of map) {
    if (a.newCount <= 0) continue
    const deltaPct = a.prevCount === 0
      ? (a.newCount > 0 ? 100 : 0)
      : Math.round(((a.newCount - a.prevCount) / a.prevCount) * 100)
    const topStores = Array.from(a.stores.entries())
      .sort((x, y) => y[1] - x[1]).slice(0, 3).map(e => e[0])
    rows.push({ niche, newCount: a.newCount, prevCount: a.prevCount, deltaPct, topStores })
  }
  rows.sort((x, y) => y.deltaPct - x.deltaPct || y.newCount - x.newCount)
  return rows.slice(0, limit)
}
