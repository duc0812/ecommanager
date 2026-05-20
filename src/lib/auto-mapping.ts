import type { SupplierInput } from '@/lib/pl-calculator'

export type SupplierProductCandidate = SupplierInput & {
  sku: string
  supplierName: string
  supplierCode: string
  supplierPreferenceRank: number
  productName?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
}

export type OrderLineForMapping = {
  sku: string | null
  title: string
  variantTitle: string | null
  productTags?: string[]
  productType?: string | null
}

export type MappingResult = {
  supplier: SupplierProductCandidate | null
  score: number
  reasons: string[]
}

const DESIGN_2D = ['2d', 'dtg', 'flat', 'standard', 'screen print', 'screen-print']
const DESIGN_3D = ['3d', 'all over print', 'aop', 'sublimation', 'cut sew', 'cut-sew']

function norm(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function words(v: string | null | undefined): string[] {
  return norm(v).split(/[^a-z0-9]+/).filter(Boolean)
}

function includesToken(haystack: string, needle: string | null | undefined): boolean {
  const n = norm(needle)
  if (!n) return false
  if (n.length <= 3) return words(haystack).includes(n)
  return haystack.includes(n)
}

function detectDesignKind(values: Array<string | null | undefined>): '2D' | '3D' | null {
  const text = values.map(norm).filter(Boolean).join(' ')
  if (!text) return null
  if (DESIGN_3D.some(token => text.includes(token))) return '3D'
  if (DESIGN_2D.some(token => text.includes(token))) return '2D'
  return null
}

function overlapScore(a: string | null | undefined, b: string | null | undefined): number {
  const aWords = new Set(words(a).filter(w => w.length > 2))
  const bWords = words(b).filter(w => w.length > 2)
  if (aWords.size === 0 || bWords.length === 0) return 0
  return bWords.filter(w => aWords.has(w)).length
}

export function resolveSupplierForOrderLine(
  line: OrderLineForMapping,
  candidates: SupplierProductCandidate[],
): MappingResult {
  const lineText = [
    line.title,
    line.variantTitle,
    line.productType,
    ...(line.productTags ?? []),
  ].map(norm).filter(Boolean).join(' ')
  const lineDesignKind = detectDesignKind([line.productType, line.variantTitle, line.title, ...(line.productTags ?? [])])

  let best: MappingResult = { supplier: null, score: 0, reasons: [] }

  for (const c of candidates) {
    let score = 0
    const reasons: string[] = []

    const candidateDesignKind = detectDesignKind([c.productType, c.productName])
    if (lineDesignKind && candidateDesignKind) {
      if (lineDesignKind === candidateDesignKind) {
        score += 45
        reasons.push(`design:${lineDesignKind}`)
      } else {
        score -= 80
        reasons.push(`design-mismatch:${candidateDesignKind}`)
      }
    }

    if (includesToken(lineText, c.productType)) {
      score += 25
      reasons.push('productType')
    }
    if (includesToken(lineText, c.variant1Value) || includesToken(lineText, c.variant2Value)) {
      score += 10
      reasons.push('variant')
    }

    const nameOverlap = overlapScore(line.title, c.productName)
    if (nameOverlap > 0) {
      score += Math.min(20, nameOverlap * 5)
      reasons.push('productName')
    }

    score += Math.min(10, c.supplierPreferenceRank)

    if (
      !best.supplier ||
      score > best.score ||
      (score === best.score && c.supplierPreferenceRank > best.supplier.supplierPreferenceRank)
    ) {
      best = { supplier: score > 0 ? c : null, score, reasons }
    }
  }

  return best
}
