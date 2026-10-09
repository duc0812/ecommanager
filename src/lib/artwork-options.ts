export type OptionCombo = Record<string, string>
export type ArtworkSplit = { printTemplateId: string; optionName: string }
export type OptionSummary = { name: string; values: string[] }

export function parseVariantOptions(json: string | Record<string, unknown> | null | undefined): OptionCombo {
  let raw: unknown = json
  if (typeof json === 'string') {
    try { raw = JSON.parse(json) } catch { return {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: OptionCombo = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string' || !k.trim() || !v.trim()) continue
    out[k.trim()] = v.trim()
  }
  return out
}

export function canonicalOptionKey(combo: OptionCombo): string {
  const keys = Object.keys(combo).map(k => k.trim()).filter(k => k && typeof combo[k] === 'string' && combo[k].trim())
  if (keys.length === 0) return ''
  keys.sort()
  const sorted: OptionCombo = {}
  for (const k of keys) sorted[k] = combo[k].trim()
  return JSON.stringify(sorted)
}

export function parseOptionKey(key: string | null | undefined): OptionCombo | null {
  if (key === null || key === undefined || key === '') return {}
  let raw: unknown
  try { raw = JSON.parse(key) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0 || entries.some(([k, v]) => !k.trim() || typeof v !== 'string' || !v.trim())) return null
  return Object.fromEntries(entries) as OptionCombo
}

export function isCanonicalOptionKey(key: string): boolean {
  const combo = parseOptionKey(key)
  return combo !== null && canonicalOptionKey(combo) === key
}

export function optionComboLabel(key: string): string {
  const combo = parseOptionKey(key)
  if (!combo) return key
  return Object.entries(combo).map(([k, v]) => `${k}: ${v}`).join(' · ')
}

export function comboMatches(combo: OptionCombo, lineOptions: OptionCombo): boolean {
  const keys = Object.keys(combo)
  return keys.length > 0 && keys.every(k => lineOptions[k] !== undefined && lineOptions[k] === combo[k])
}

export function slotOptionKey(lineOptions: OptionCombo, splitOption: string | null | undefined): string {
  if (!splitOption) return ''
  const value = lineOptions[splitOption]
  return value ? canonicalOptionKey({ [splitOption]: value }) : ''
}

export function parseArtworkSplits(json: string | null | undefined): ArtworkSplit[] {
  if (!json) return []
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ArtworkSplit[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const { printTemplateId, optionName } = s as Record<string, unknown>
    if (typeof printTemplateId !== 'string' || !printTemplateId || typeof optionName !== 'string' || !optionName.trim()) continue
    if (seen.has(printTemplateId)) continue
    seen.add(printTemplateId)
    out.push({ printTemplateId, optionName: optionName.trim() })
  }
  return out
}

export function splitOptionFor(splits: ArtworkSplit[], templateId: string | null | undefined): string | null {
  if (!templateId) return null
  return splits.find(s => s.printTemplateId === templateId)?.optionName ?? null
}

export function withSplit(splits: ArtworkSplit[], templateId: string, optionName: string | null): ArtworkSplit[] {
  const rest = splits.filter(s => s.printTemplateId !== templateId)
  return optionName ? [...rest, { printTemplateId: templateId, optionName }] : rest
}

export function resolveEntryForLine<E extends { optionKey: string }>(
  templateEntries: E[], lineOptions: OptionCombo, splitOption: string | null | undefined,
): E | null {
  if (splitOption) {
    const match = templateEntries.find(e => {
      if (!e.optionKey) return false
      const combo = parseOptionKey(e.optionKey)
      if (!combo) return false
      const keys = Object.keys(combo)
      return keys.length === 1 && keys[0] === splitOption && comboMatches(combo, lineOptions)
    })
    if (match) return match
  }
  return templateEntries.find(e => e.optionKey === '') ?? null
}

export function summarizeOptions(lines: Array<{ variantOptions: string | null }>): OptionSummary[] {
  const byName = new Map<string, Set<string>>()
  for (const l of lines) {
    for (const [k, v] of Object.entries(parseVariantOptions(l.variantOptions))) {
      if (!byName.has(k)) byName.set(k, new Set())
      byName.get(k)!.add(v)
    }
  }
  return Array.from(byName.entries()).map(([name, values]) => ({ name, values: Array.from(values).sort((a, b) => a.localeCompare(b)) }))
}

export function optionsLabel(options: OptionSummary[]): string {
  return options.map(o => `${o.name}: ${o.values.join(', ')}`).join(' · ')
}
