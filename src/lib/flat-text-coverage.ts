import { customerValues } from '@/lib/artwork-render-eligibility'
import { parseArtworkSplits } from '@/lib/artwork-options'
import { resolveLineEntry } from '@/lib/artwork-slots'
import type { LocalEntry } from '@/lib/artwork-library-state'

/** What scripts/sync-library-state.py copies from a flat-text spec.json. Read the same way as flat_text_batch.py on the office PC. */
export type FlatTextSpec = {
  design: string; supplierSku?: string | null
  skuIs?: string | null; skuContains?: string | null; skuNot?: string | null; skuEnds?: string | null; variantContains?: string | null
  minOrder?: number | null; match?: Record<string, string> | null
  fields: string[]; noTextOk?: boolean; customall?: boolean
}

export type LocalLibraryLine = {
  sku: string | null; supplierSku: string | null; variantTitle: string | null; orderNumber: string
  templateId: string; variantOptions: string | null; artworkSplits: string | null
  personalization: { key: string; value: string }[]
}

const ALIASES: Record<string, string[]> = {
  'custom name': ['custom name/text', 'name', 'your name', 'enter name', 'enter your personalization', 'custom text'],
  'custom name/text': ['custom name'], 'your name': ['custom name', 'name'], 'custom text': ['custom name'],
}

const fieldKey = (key: string) => key.toLowerCase().trim().replace(/[:?\s]+$/, '')
const isAnswer = (value: string) => ['yes', 'no'].includes(value.trim().toLowerCase())

export function designOf(sku: string | null): string {
  const code = /=([A-Za-z0-9]+)$/.exec(sku ?? '')
  return code ? code[1] : (sku ?? '').trim().split(/[-\s]/)[0]
}

/** A lone No prints no name, whatever is left in the box. Yes and No together come from Customall flattening the artworks a shopper tried. */
function saidNoAlone(pairs: LocalLibraryLine['personalization']): boolean {
  const answers = pairs.filter(p => p.key.toLowerCase().includes('yes or no') || ['custom name', 'custom name/text'].includes(fieldKey(p.key))).map(p => p.value.trim().toLowerCase())
  return answers.includes('no') && !answers.includes('yes')
}

function hasValue(field: string, pairs: LocalLibraryLine['personalization']): boolean {
  const want = [field.toLowerCase(), ...(ALIASES[field.toLowerCase()] ?? [])]
  return pairs.some(p => want.includes(fieldKey(p.key)) && p.value.trim() !== '' && !isAnswer(p.value))
}

function specServes(s: FlatTextSpec, line: LocalLibraryLine): boolean {
  const sku = (line.sku ?? '').trim().toUpperCase()
  const orderNo = Number(/\d+/.exec(line.orderNumber)?.[0] ?? 0)
  return s.design === designOf(line.sku)
    && (!s.supplierSku || (line.supplierSku ?? '').toUpperCase().startsWith(s.supplierSku.toUpperCase()))
    && (!s.skuIs || s.skuIs.toUpperCase() === sku)
    && (!s.skuContains || sku.includes(s.skuContains.toUpperCase()))
    && (!s.skuNot || !sku.includes(s.skuNot.toUpperCase()))
    && (!s.skuEnds || sku.endsWith(s.skuEnds.toUpperCase()))
    && (!s.variantContains || (line.variantTitle ?? '').toUpperCase().includes(s.variantContains.toUpperCase()))
    && (!s.minOrder || orderNo >= s.minOrder)
    && Object.entries(s.match ?? {}).every(([k, v]) => line.personalization.some(p => fieldKey(p.key) === k.toLowerCase() && p.value.trim().toLowerCase() === v.toLowerCase()))
}

function nameIsSettled(s: FlatTextSpec, pairs: LocalLibraryLine['personalization']): boolean {
  return !!s.customall || !!s.noTextOk || s.fields.length === 0 || saidNoAlone(pairs) || s.fields.some(f => hasValue(f, pairs))
}

function flatTextServes(entries: LocalEntry[], line: LocalLibraryLine): boolean {
  const specs = entries.filter(e => e.status === 'READY').flatMap(e => e.specs ?? []).filter(s => specServes(s, line))
  // A shopper who changed a choice leaves both values: a person looks at the preview.
  if (specs.length > 1 && specs.some(s => s.match)) return false
  return specs.some(s => nameIsSettled(s, line.personalization))
}

/** A READY PSD serves a line when the customer filled every field, or said no to the name. The PC renders all its areas: LIT5982_2 came out in 5 pieces. */
export function autoFromLocalLibrary(entries: LocalEntry[], line: LocalLibraryLine): boolean {
  if (flatTextServes(entries, line)) return true
  const psd = entries.filter(e => !e.specs)
  const entry = resolveLineEntry(psd, line.templateId, line.variantOptions, parseArtworkSplits(line.artworkSplits))
  if (entry?.status !== 'READY' || !entry.fields) return false
  if (saidNoAlone(line.personalization)) return true
  const values = customerValues(entry.fields, line.personalization)
  return entry.fields.every(f => values[f] !== undefined)
}
