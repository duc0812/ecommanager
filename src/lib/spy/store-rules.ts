export const SPY_STORE_RULES_KEY = 'spy.store_rules'

// What one competitor's own tags mean, decoded store by store (competitor-store-analyzer skill).
// Stores without an entry only get the generic best-seller + ads rules.
export type StoreRules = {
  salesStrongTags: string[]
  salesTagsWithAds: string[]
  scaleStrongTags: string[]
  scaleTagsWithAds: string[]
  codeTagRegex: string | null
  codeLinkRegex: string | null
  killTitlePrefix: string | null
}

export type StoreRulesMap = Record<string, StoreRules>

const EMPTY: StoreRules = {
  salesStrongTags: [], salesTagsWithAds: [], scaleStrongTags: [], scaleTagsWithAds: [],
  codeTagRegex: null, codeLinkRegex: null, killTitlePrefix: null,
}

// familystore decoded 2026-09-25 (research/12_familystore_ads_x_tags.md): summer30 ⊃ summer20 ⊃ Summer10 tiers,
// FB=BOF = Facebook best-seller, hot = being scaled. Codes CT6091622 carry the design date (2026-09-16).
export const DEFAULT_STORE_RULES: StoreRulesMap = {
  'familystore.com': {
    salesStrongTags: ['summer20', 'Summer10', 'FB=BOF'],
    salesTagsWithAds: ['summer30'],
    scaleStrongTags: ['hot'],
    scaleTagsWithAds: ['summer20'],
    codeTagRegex: '^C[TUG](?<y>\\d)(?<m>\\d{2})(?<d>\\d{2})\\d{2}',
    codeLinkRegex: 'familystore\\.com/(C[TUG]\\d{7})',
    killTitlePrefix: 'Delete |',
  },
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []
}

function validRegex(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  try { new RegExp(v); return v } catch { return null }
}

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')
}

export function parseStoreRules(json: string | null | undefined): StoreRulesMap {
  let o: any = null
  if (json) { try { o = JSON.parse(json) } catch { o = null } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return DEFAULT_STORE_RULES
  const out: StoreRulesMap = {}
  for (const [domain, r] of Object.entries<any>(o)) {
    if (!r || typeof r !== 'object') continue
    out[normalizeDomain(domain)] = {
      ...EMPTY,
      salesStrongTags: strList(r.salesStrongTags),
      salesTagsWithAds: strList(r.salesTagsWithAds),
      scaleStrongTags: strList(r.scaleStrongTags),
      scaleTagsWithAds: strList(r.scaleTagsWithAds),
      codeTagRegex: validRegex(r.codeTagRegex),
      codeLinkRegex: validRegex(r.codeLinkRegex),
      killTitlePrefix: typeof r.killTitlePrefix === 'string' && r.killTitlePrefix ? r.killTitlePrefix : null,
    }
  }
  return out
}
