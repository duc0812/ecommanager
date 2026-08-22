export function parseKeywords(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr.map(k => String(k).trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function nicheMatches(title: string | null, keywords: string[]): boolean {
  if (!title || keywords.length === 0) return false
  const t = title.toLowerCase()
  return keywords.some(k => k.length > 0 && t.includes(k.toLowerCase()))
}

export function nicheOrWhere(keywords: string[], fields: string[]): { OR: any[] } | undefined {
  const kws = keywords.filter(k => k.length > 0)
  if (kws.length === 0 || fields.length === 0) return undefined
  const OR: any[] = []
  for (const k of kws) for (const f of fields) OR.push({ [f]: { contains: k } })
  return { OR }
}
