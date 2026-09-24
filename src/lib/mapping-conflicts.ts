import type { VariantCondition } from '@/lib/product-mapping'

// Static check over the Product Base configuration: which bases of one Shopify product type can
// both match the same order line. The resolver cannot pick between them, so the answer depends
// on load order — the configuration has to separate them instead.

export type OverlapReason = 'no_conditions' | 'different_options' | 'overlapping_values'

export type BaseOverlap = {
  shopifyProductType: string
  baseIds: [string, string]
  baseNames: [string, string]
  reason: OverlapReason
  sharedValues?: string[]
}

type BaseLike = {
  id: string
  name: string
  shopifyProductType: string
  variantConditions: string
}

const normalize = (v: string) => v.toLowerCase().trim()
// Same leniency the resolver's valueMatches uses, so "Sweatshirts" and "Sweatshirt" are one value.
const comparable = (v: string) => {
  const n = normalize(v)
  return n.endsWith('s') ? n.slice(0, -1) : n
}

function conditionsOf(base: BaseLike): VariantCondition[] {
  try {
    const parsed = JSON.parse(base.variantConditions)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// Keyed by the comparable form, valued by the spelling the user actually typed, so a warning
// reads "XL" rather than "xl".
function valuesOf(cond: VariantCondition): Map<string, string> {
  const raw = cond.anyOf ?? (cond.value !== undefined ? [cond.value] : [])
  return new Map(raw.map(v => [comparable(v), v]))
}

function overlapOf(a: BaseLike, b: BaseLike): Omit<BaseOverlap, 'shopifyProductType' | 'baseIds' | 'baseNames'> | null {
  const ca = conditionsOf(a)
  const cb = conditionsOf(b)
  // `[].every()` is true, so a base with no conditions matches every line of its product type.
  if (ca.length === 0 || cb.length === 0) return { reason: 'no_conditions' }

  const keysA = new Set(ca.map(c => normalize(c.optionName)))
  const keysB = new Set(cb.map(c => normalize(c.optionName)))
  const shared = Array.from(keysA).filter(k => keysB.has(k))
  // No common option: a line carrying both options satisfies both bases, always.
  if (shared.length === 0) return { reason: 'different_options' }

  // Both bases must be satisfiable at once for every option they share.
  const sharedValues: string[] = []
  for (const key of shared) {
    const va = valuesOf(ca.find(c => normalize(c.optionName) === key)!)
    const vb = valuesOf(cb.find(c => normalize(c.optionName) === key)!)
    const both = Array.from(va.entries()).filter(([k]) => vb.has(k)).map(([, original]) => original)
    if (both.length === 0) return null
    sharedValues.push(...both)
  }
  // An option only one of them constrains cannot keep them apart either.
  if (shared.length < Math.max(keysA.size, keysB.size)) return { reason: 'different_options' }
  return { reason: 'overlapping_values', sharedValues: Array.from(new Set(sharedValues)) }
}

export function findBaseOverlaps(bases: BaseLike[]): BaseOverlap[] {
  const byType = new Map<string, BaseLike[]>()
  for (const b of bases) {
    const k = normalize(b.shopifyProductType)
    byType.set(k, [...(byType.get(k) ?? []), b])
  }

  const out: BaseOverlap[] = []
  for (const group of Array.from(byType.values())) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const hit = overlapOf(group[i], group[j])
        if (!hit) continue
        out.push({
          shopifyProductType: group[i].shopifyProductType,
          baseIds: [group[i].id, group[j].id],
          baseNames: [group[i].name.trim(), group[j].name.trim()],
          ...hit,
        })
      }
    }
  }
  return out
}
