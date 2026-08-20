export function isNewProduct(firstSeenAt: Date, now: Date = new Date(), windowDays = 7): boolean {
  return firstSeenAt.getTime() >= now.getTime() - windowDays * 24 * 60 * 60 * 1000
}

export function groupByNiche(products: { productType: string | null }[]): { niche: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const p of products) {
    const key = p.productType || 'Uncategorized'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts, ([niche, count]) => ({ niche, count })).sort((a, b) => b.count - a.count)
}
