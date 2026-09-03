import { isNonProductLine } from '@/lib/order-lines'

export type ClassifyLine = {
  sku: string | null
  productTitle: string
  shopifyProductType?: string | null
  customAttributes: Array<{ key: string; value: string }>
  productTags: string[]
}

export type OrderType = 'CUSTOM' | 'NON_CUSTOM'

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

export function isLineCustomized(line: {
  customAttributes: Array<{ key: string; value: string }>
  previewCdnUrl?: string | null
  productTags?: string[]
}): boolean {
  if (line.previewCdnUrl && line.previewCdnUrl.trim()) return true
  if ((line.productTags ?? []).includes('Custom Name')) return true
  // A customer-entered custom field marks the line customized: the hidden `_print_files`
  // (Customcy/Customily-style apps), or ANY visible line-item property added by an external
  // personalization app (e.g. "YOUR NAME": "Janice") — excluding variant-selector keys.
  return line.customAttributes.some(a =>
    a.key === '_print_files' ||
    (!a.key.startsWith('_') && !VARIANT_PROP_KEYS.has(a.key.toLowerCase().trim())),
  )
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
      const preview = line.customAttributes.find(a => a.key === '_customall_preview')?.value ?? ''
      const printFile = line.customAttributes.find(a => a.key === '_customall_print_file')?.value ?? ''
      const customUrl = line.customAttributes.find(a => a.key === '_customized_url')?.value ?? ''
      let printAreas = ''
      try {
        const pf = line.customAttributes.find(a => a.key === '_print_files')?.value
        if (pf) {
          const parsed = JSON.parse(pf) as Array<{ print_area: string; url: string }>
          printAreas = parsed.map(p => `  - ${p.print_area}: ${p.url}`).join('\n')
        }
      } catch {}
      sections.push(
        `**${lineNumber}. ${line.productTitle}** (${line.sku}${line.variantTitle ? ` / ${line.variantTitle}` : ''}, qty: ${line.qty})` +
        `\nDrive attachment name: ${orderToken}_${lineNumber}` +
        (preview ? `\nPreview: ${preview}` : '') +
        (printFile ? `\nPrint file: ${printFile}` : '') +
        (printAreas ? `\nPrint areas:\n${printAreas}` : '') +
        (customUrl ? `\nCustomized URL: ${customUrl}` : ''),
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
    ].filter(Boolean).join('\n')
  })
  return {
    name,
    desc: `Design missing — prepare per-supplier design:\n\n${nonCustomSections.join('\n\n---\n\n')}${digitalNote}`,
  }
}
