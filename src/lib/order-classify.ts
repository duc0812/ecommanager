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

export function buildTrelloCardContent(
  orderName: string,
  lines: Array<ClassifyLine & { variantTitle: string | null; qty: number }>,
  orderType: OrderType,
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

  const skuList = productLines
    .map((l, idx) => `${idx + 1}. ${l.sku} (${orderToken}_${idx + 1})`)
    .join(', ')
  return {
    name,
    desc: `Design missing - create design for SKU: ${skuList}\n\nProducts: ${lines.map(l => l.productTitle).join(', ')}${digitalNote}`,
  }
}
