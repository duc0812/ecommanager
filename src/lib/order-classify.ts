export type ClassifyLine = {
  sku: string | null
  productTitle: string
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
  const skuParts = lines
    .filter(l => l.sku)
    .map(l => `${l.sku}${l.variantTitle ? ` [${l.variantTitle}]` : ''}`)
    .join(' / ')
  const name = `${orderName} - ${skuParts || 'N/A'}`

  if (orderType === 'CUSTOM') {
    const sections: string[] = []
    for (const line of lines) {
      if (!line.sku) continue
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
        `**${line.productTitle}** (${line.sku}${line.variantTitle ? ` / ${line.variantTitle}` : ''}, qty: ${line.qty})` +
        (preview ? `\n🖼 Preview: ${preview}` : '') +
        (printFile ? `\n🖨 Print file: ${printFile}` : '') +
        (printAreas ? `\n🎨 Print areas:\n${printAreas}` : '') +
        (customUrl ? `\n🔗 Customized URL: ${customUrl}` : ''),
      )
    }
    return { name, desc: sections.join('\n\n---\n\n') }
  }

  // NON_CUSTOM
  const skuList = lines.filter(l => l.sku).map(l => l.sku).join(', ')
  return {
    name,
    desc: `⚠️ Design chưa có — cần tạo design cho SKU: ${skuList}\n\nSản phẩm: ${lines.map(l => l.productTitle).join(', ')}`,
  }
}
