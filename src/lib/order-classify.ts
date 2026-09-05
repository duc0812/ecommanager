import { isNonProductLine } from '@/lib/order-lines'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'

export type ClassifyLine = {
  sku: string | null
  productTitle: string
  shopifyProductType?: string | null
  customAttributes: Array<{ key: string; value: string }>
  productTags: string[]
}

export type OrderType = 'CUSTOM' | 'NON_CUSTOM'

// DEPRECATED: whole-order classifier, superseded by per-line isLineCustomized + reduceOrderType
// in the sync route. Kept only for buildTrelloCardContent's OrderType arg / back-compat.
export function classifyOrderLines(lines: ClassifyLine[]): OrderType {
  for (const line of lines) {
    if (line.customAttributes.some(a => a.key === '_print_files')) return 'CUSTOM'
    if (line.productTags.includes('Custom Name')) return 'CUSTOM'
  }
  return 'NON_CUSTOM'
}

// Line-item property keys that are variant selectors, not customer customization — excluded
// so a "Size"/"Color" property does not falsely mark a line as customized.
const VARIANT_PROP_KEYS = new Set(['size', 'color', 'colour', 'style', 'variant', 'option', 'title', 'quantity'])

// The customer-entered properties a designer has to read off the card. Same filter the
// customization check uses, so anything that marks a line CUSTOM is also printable on Trello.
export function visibleCustomAttributes(
  attrs: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  return attrs.filter(a => {
    if (a.key.startsWith('_')) return false
    if (VARIANT_PROP_KEYS.has(a.key.toLowerCase().trim())) return false
    return !!(a.value && a.value.trim())
  })
}

export function isLineCustomized(line: {
  customAttributes: Array<{ key: string; value: string }>
  previewCdnUrl?: string | null
}): boolean {
  if (line.previewCdnUrl && line.previewCdnUrl.trim()) return true
  // Old logic (hidden `_print_files` from Customcy/Customily-style apps) PLUS the exception:
  // ANY visible non-"_"-prefixed line-item property with a non-empty value added by an external
  // personalization app (e.g. "YOUR NAME": "Janice"), excluding variant-selector keys.
  // Product tags are intentionally NOT used — many non-custom products carry the 'Custom Name'
  // tag, so it is an unreliable customization signal.
  if (line.customAttributes.some(a => a.key === '_print_files')) return true
  return visibleCustomAttributes(line.customAttributes).length > 0
}

function formatPersonalizationItems(attrs: Array<{ key: string; value: string }>): string {
  return attrs
    .map(a => `  - ${a.key}: ${a.value.trim().replace(/\r?\n/g, '\n    ')}`)
    .join('\n')
}

// Everything the customer supplied for one line, in the order a designer needs it:
// the text to print first, then the artwork references.
function customerInputLines(line: ClassifyLine): string[] {
  const out: string[] = []
  const preview = extractPreviewCdnUrl(line.customAttributes)
  const personalization = visibleCustomAttributes(line.customAttributes)
    .filter(a => a.value !== preview)
  if (personalization.length > 0) {
    out.push(`Personalization (customer input):\n${formatPersonalizationItems(personalization)}`)
  }
  if (preview) out.push(`Preview: ${preview}`)

  const printFile = line.customAttributes.find(a => a.key === '_customall_print_file')?.value
  if (printFile) out.push(`Print file: ${printFile}`)

  try {
    const pf = line.customAttributes.find(a => a.key === '_print_files')?.value
    if (pf) {
      const parsed = JSON.parse(pf) as Array<{ print_area: string; url: string }>
      const printAreas = parsed.map(p => `  - ${p.print_area}: ${p.url}`).join('\n')
      if (printAreas) out.push(`Print areas:\n${printAreas}`)
    }
  } catch {}

  const customUrl = line.customAttributes.find(a => a.key === '_customized_url')?.value
  if (customUrl) out.push(`Customized URL: ${customUrl}`)
  return out
}

export type LineFamily = 'CUSTOM' | 'DUAL' | 'NON_CUSTOM'

export function lineFamily(input: { customized: boolean; designType: string }): LineFamily {
  if (input.customized) return 'CUSTOM'
  if (input.designType === 'DUAL') return 'DUAL'
  return 'NON_CUSTOM'
}

export function reduceOrderType(
  families: LineFamily[],
): 'NON_CUSTOM' | 'CUSTOM' | 'DUAL' | 'MIXED' | 'UNKNOWN' {
  if (families.length === 0) return 'UNKNOWN'
  const distinct = Array.from(new Set(families))
  if (distinct.length === 1) return distinct[0]
  return 'MIXED'
}

// Cards created before the personalization block existed are patched in place instead of
// being rebuilt, so supplier/template/master-artwork notes already on them survive.
export const PERSONALIZATION_MARKER = '**🎨 Customer personalization**'

export function buildPersonalizationSections(
  orderName: string,
  lines: Array<{
    sku: string | null
    productTitle: string
    variantTitle: string | null
    shopifyProductType?: string | null
    customAttributes: Array<{ key: string; value: string }>
  }>,
): string | null {
  const orderToken = orderName.replace(/^#/, '')
  const parts: string[] = []
  let productNumber = 0
  for (const line of lines) {
    const nonProduct = isNonProductLine(line)
    if (!nonProduct) productNumber += 1
    const attrs = visibleCustomAttributes(line.customAttributes)
    if (attrs.length === 0) continue
    const label = nonProduct
      ? `**+ ${line.productTitle}${line.variantTitle ? ` / ${line.variantTitle}` : ''}** (add-on)`
      : `**${productNumber}. ${line.sku ?? line.productTitle}** (${orderToken}_${productNumber})`
    parts.push(`${label}\n${formatPersonalizationItems(attrs)}`)
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

export function mergePersonalizationIntoDesc(desc: string, block: string): string {
  const idx = desc.indexOf(PERSONALIZATION_MARKER)
  const base = (idx === -1 ? desc : desc.slice(0, idx)).replace(/\s*---\s*$/, '').trimEnd()
  return base ? `${base}\n\n---\n\n${block}` : block
}

export function buildTrelloCardContent(
  orderName: string,
  lines: Array<ClassifyLine & { variantTitle: string | null; qty: number; supplierName?: string | null; designTemplateUrl?: string | null }>,
  orderType: OrderType,
  masterArtworkBySku?: Map<string, string | null>,
): { name: string; desc: string } {
  const skuLines = lines.filter(l => l.sku)
  const productLines = skuLines.filter(l => !isNonProductLine(l))
  const digitalLines = skuLines.filter(l => isNonProductLine(l))
  const digitalNote = digitalLines.length === 0 ? '' : '\n\n---\n\n**Add-ons (digital):**\n' +
    digitalLines.map(l => {
      const attrs = l.customAttributes
        .filter(a => !a.key.startsWith('_'))
        .map(a => `${a.key}: ${a.value}`)
        .join(', ')
      return `- ${l.productTitle}${l.variantTitle ? ` [${l.variantTitle}]` : ''} x${l.qty}${attrs ? ` — ${attrs}` : ''}`
    }).join('\n')
  const orderToken = orderName.replace(/^#/, '')
  const skuParts = productLines
    .map(l => `${l.sku}${l.variantTitle ? ` [${l.variantTitle}]` : ''}`)
    .join(' / ')
  const name = `${orderName} - ${skuParts || 'N/A'}`

  if (orderType === 'CUSTOM') {
    const sections: string[] = []
    for (let idx = 0; idx < productLines.length; idx += 1) {
      const line = productLines[idx]
      const lineNumber = idx + 1
      const inputs = customerInputLines(line)
      sections.push(
        `**${lineNumber}. ${line.productTitle}** (${line.sku}${line.variantTitle ? ` / ${line.variantTitle}` : ''}, qty: ${line.qty})` +
        `\nDrive attachment name: ${orderToken}_${lineNumber}` +
        (inputs.length > 0 ? `\n${inputs.join('\n')}` : ''),
      )
    }
    return { name, desc: sections.join('\n\n---\n\n') + digitalNote }
  }

  const nonCustomSections = productLines.map((l, idx) => {
    const master = l.sku ? masterArtworkBySku?.get(l.sku) ?? null : null
    return [
      `**${idx + 1}. ${l.sku} (${orderToken}_${idx + 1})** — ${l.productTitle}${l.variantTitle ? ` / ${l.variantTitle}` : ''}`,
      l.supplierName ? `Supplier: ${l.supplierName}` : null,
      l.designTemplateUrl ? `Template: ${l.designTemplateUrl}` : null,
      master ? `Master artwork: ${master}` : null,
      // MIXED/DUAL orders land here too — a customized line inside them still needs its input shown.
      ...customerInputLines(l),
    ].filter(Boolean).join('\n')
  })
  return {
    name,
    desc: `Design missing — prepare per-supplier design:\n\n${nonCustomSections.join('\n\n---\n\n')}${digitalNote}`,
  }
}
