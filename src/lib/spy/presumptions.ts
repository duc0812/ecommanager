import { prisma } from '@/lib/db'
import { parseAdLink } from './ad-link'
import { activeDays, isScalingSummary } from './ad-signals'
import { parseStoreRules, normalizeDomain, SPY_STORE_RULES_KEY, type StoreRules, type StoreRulesMap } from './store-rules'

import { LEVELS, type Level } from './presumption-levels'

export { LEVELS, LEVEL_LABELS, type Level } from './presumption-levels'

const DAY = 24 * 60 * 60 * 1000
const NEW_PRODUCT_DAYS = 30

export type AdInput = {
  id: string
  isActive: boolean
  startDate: Date | null
  endDate: Date | null
  collationCount: number | null
  firstCollationCount: number | null
  everActive: boolean
  observationCount: number
}

export type ProductInput = {
  title: string | null
  tags: string[]
  publishedAt: Date | null
  firstSeenAt: Date
  bsRank: number | null
  bsPrevRank: number | null
  ads: AdInput[]
}

export type Presumed = { level: Level; rules: string[] }

function rank(l: Level) { return LEVELS.indexOf(l) }

export function productLaunchDate(p: Pick<ProductInput, 'tags' | 'publishedAt' | 'firstSeenAt'>, rules: StoreRules | null): Date {
  if (rules?.codeTagRegex) {
    const re = new RegExp(rules.codeTagRegex)
    for (const t of p.tags) {
      const g = t.match(re)?.groups
      if (g?.y && g.m && g.d) {
        const d = new Date(Date.UTC(2020 + Number(g.y), Number(g.m) - 1, Number(g.d)))
        if (!Number.isNaN(d.getTime())) return d
      }
    }
  }
  return p.publishedAt ?? p.firstSeenAt
}

export function classifyProduct(p: ProductInput, rules: StoreRules | null, now: Date = new Date()): Presumed | null {
  if (rules?.killTitlePrefix && (p.title ?? '').startsWith(rules.killTitlePrefix)) return null
  const fired: Array<[string, Level]> = []
  const hit = (id: string, level: Level) => fired.push([id, level])

  const active = p.ads.filter(a => a.isActive)
  const nActive = active.length
  const { bsRank, bsPrevRank } = p

  if (bsRank != null && bsRank <= 20) hit('BS_TOP20', 'SALES_STRONG')
  else if (bsRank != null && bsRank <= 100) hit('BS_TOP100', 'SALES')
  if (bsRank != null && bsPrevRank != null && bsRank <= 150 && bsPrevRank - bsRank >= 30) hit('BS_CLIMB', 'SALES')

  if (active.some(a => activeDays(a.startDate, a.endDate, now) >= 10)) hit('AD_ALIVE10', 'SALES')
  const weekAgo = now.getTime() - 7 * DAY
  const freshActive = active.some(a => a.startDate && a.startDate.getTime() >= weekAgo)
  const olderAd = p.ads.some(a => a.startDate && a.startDate.getTime() < weekAgo)
  if (freshActive && olderAd) hit('AD_NEW_ON_OLD', 'SALES')

  if (nActive >= 6) hit('ADS_6', 'SCALE_STRONG')
  else if (nActive >= 3) hit('ADS_3', 'SCALE')
  if (nActive >= 3 && bsRank != null && bsRank <= 20) hit('ADS_3_TOP20', 'SCALE_STRONG')
  if (active.some(a => activeDays(a.startDate, a.endDate, now) >= 45)) hit('AD_ALIVE45', 'SCALE')
  if (nActive >= 2 && active.some(a => isScalingSummary(a))) hit('ADS_GROWING', 'SCALE')

  if (rules) {
    const tags = new Set(p.tags)
    const any = (list: string[]) => list.some(t => tags.has(t))
    if (any(rules.salesStrongTags)) hit('TAG_SALES_STRONG', 'SALES_STRONG')
    if (nActive >= 1 && any(rules.salesTagsWithAds)) hit('TAG_SALES_ADS', 'SALES')
    if (any(rules.scaleStrongTags)) hit('TAG_SCALE_STRONG', 'SCALE_STRONG')
    if (nActive >= 2 && any(rules.scaleTagsWithAds)) hit('TAG_SCALE_ADS', 'SCALE')
  }

  if (fired.length === 0) return null
  let level = fired.reduce<Level>((best, [, l]) => (rank(l) > rank(best) ? l : best), 'SALES')
  const ruleIds = fired.map(([id]) => id)
  if (rank(level) >= rank('SCALE')) {
    const ageDays = (now.getTime() - productLaunchDate(p, rules).getTime()) / DAY
    if (ageDays <= NEW_PRODUCT_DAYS) { level = 'NEW_NEW_SCALE'; ruleIds.push('NEW_LE30') }
  }
  return { level, rules: ruleIds }
}

function parseTags(json: string | null): string[] {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

export async function loadStoreRules(): Promise<StoreRulesMap> {
  const row = await prisma.appSetting.findUnique({ where: { key: SPY_STORE_RULES_KEY } })
  return parseStoreRules(row?.value)
}

export async function recomputePresumptions(now: Date = new Date()) {
  const rulesMap = await loadStoreRules()
  const stores = await prisma.spyStore.findMany({ where: { status: 'active' }, select: { id: true, domain: true } })
  const storeById = new Map(stores.map(s => [s.id, normalizeDomain(s.domain)]))

  const products = await prisma.spyProduct.findMany({
    where: { storeId: { in: stores.map(s => s.id) }, status: 'active' },
    select: { id: true, storeId: true, title: true, handle: true, tags: true, publishedAt: true, firstSeenAt: true },
  })

  const byHandle = new Map<string, string>()
  const byCode = new Map<string, string[]>()
  const tagsById = new Map<string, string[]>()
  for (const p of products) {
    const domain = storeById.get(p.storeId) as string
    const tags = parseTags(p.tags)
    tagsById.set(p.id, tags)
    if (p.handle) byHandle.set(`${domain}|${p.handle}`, p.id)
    const codeRe = rulesMap[domain]?.codeTagRegex
    if (codeRe) {
      const re = new RegExp(codeRe)
      for (const t of tags) {
        const m = t.match(re)
        if (!m) continue
        const key = `${domain}|${m[0].toUpperCase()}`
        byCode.set(key, [...(byCode.get(key) ?? []), p.id])
      }
    }
  }

  const linkRules = Object.entries(rulesMap)
    .filter(([, r]) => r.codeLinkRegex)
    .map(([domain, r]) => ({ domain, re: new RegExp(r.codeLinkRegex as string, 'i') }))

  const adsByProduct = new Map<string, Map<string, AdInput>>()
  const ads = await prisma.spyAd.findMany({
    select: {
      id: true, linkUrl: true, resolvedUrl: true, isActive: true, startDate: true, endDate: true,
      collationCount: true, firstCollationCount: true, everActive: true, observationCount: true,
    },
  })
  for (const a of ads) {
    const targets = new Set<string>()
    for (const url of [a.resolvedUrl, a.linkUrl]) {
      if (!url) continue
      const link = parseAdLink(url)
      if (link.kind === 'product' && link.host && link.handle) {
        const id = byHandle.get(`${link.host}|${link.handle}`)
        if (id) targets.add(id)
      }
      for (const { domain, re } of linkRules) {
        const code = url.match(re)?.[1]
        if (code) for (const id of byCode.get(`${domain}|${code.toUpperCase()}`) ?? []) targets.add(id)
      }
    }
    const input: AdInput = {
      id: a.id, isActive: a.isActive, startDate: a.startDate, endDate: a.endDate, collationCount: a.collationCount,
      firstCollationCount: a.firstCollationCount, everActive: a.everActive, observationCount: a.observationCount,
    }
    targets.forEach(id => {
      if (!adsByProduct.has(id)) adsByProduct.set(id, new Map())
      adsByProduct.get(id)!.set(a.id, input)
    })
  }

  const bsByProduct = new Map<string, { rank: number; prevRank: number | null }>()
  for (const s of stores) {
    const scan = await prisma.spyScan.findFirst({
      where: { type: 'STORE_BESTSELLER', targetId: s.id, status: 'success' },
      orderBy: { startedAt: 'desc' }, select: { id: true },
    })
    if (!scan) continue
    const rows = await prisma.spyBestSeller.findMany({ where: { scanId: scan.id }, select: { productId: true, rank: true, prevRank: true } })
    for (const r of rows) bsByProduct.set(r.productId, { rank: r.rank, prevRank: r.prevRank })
  }

  const existing = await prisma.spyPresumption.findMany({ select: { productId: true, level: true, firstFlaggedAt: true, levelSince: true } })
  const prev = new Map(existing.map(e => [e.productId, e]))

  const rows: Array<{ productId: string; storeId: string; level: Level; rules: string; firstFlaggedAt: Date; levelSince: Date; computedAt: Date }> = []
  for (const p of products) {
    const bs = bsByProduct.get(p.id)
    const adMap = adsByProduct.get(p.id)
    const domain = storeById.get(p.storeId) as string
    const rules = rulesMap[domain] ?? null
    const tags = tagsById.get(p.id) ?? []
    if (!bs && !adMap && !rules) continue
    const result = classifyProduct({
      title: p.title, tags, publishedAt: p.publishedAt, firstSeenAt: p.firstSeenAt,
      bsRank: bs?.rank ?? null, bsPrevRank: bs?.prevRank ?? null, ads: adMap ? Array.from(adMap.values()) : [],
    }, rules, now)
    if (!result) continue
    const old = prev.get(p.id)
    rows.push({
      productId: p.id, storeId: p.storeId, level: result.level, rules: JSON.stringify(result.rules),
      firstFlaggedAt: old?.firstFlaggedAt ?? now,
      levelSince: old && old.level === result.level ? old.levelSince : now,
      computedAt: now,
    })
  }

  await prisma.$transaction(async tx => {
    await tx.spyPresumption.deleteMany({})
    for (let i = 0; i < rows.length; i += 500) await tx.spyPresumption.createMany({ data: rows.slice(i, i + 500) })
  }, { timeout: 60_000 })

  const byLevel: Record<string, number> = {}
  for (const r of rows) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1
  return { flagged: rows.length, byLevel, computedAt: now.toISOString() }
}
