export function suggestParentCode(sku: string | null | undefined): string {
  const s = (sku ?? '').trim()
  if (!s) return ''
  const dash = s.indexOf('-')
  return (dash === -1 ? s : s.slice(0, dash)).trim()
}

export type ParentEntry = {
  parentCode: string
  supplierId: string
  designLink: string | null
  designType: string
}

export function matchParentEntry(
  sku: string | null | undefined,
  supplierId: string | null | undefined,
  entries: ParentEntry[],
): ParentEntry | null {
  const s = (sku ?? '').toLowerCase().trim()
  if (!s || !supplierId) return null
  let best: ParentEntry | null = null
  for (const entry of entries) {
    const pc = (entry.parentCode ?? '').toLowerCase().trim()
    if (!pc || entry.supplierId !== supplierId) continue
    if (!s.startsWith(pc)) continue
    if (!best || pc.length > best.parentCode.toLowerCase().trim().length) best = entry
  }
  return best
}
