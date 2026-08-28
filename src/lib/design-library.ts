export function designKey(sku: string, supplierId: string): string {
  return `${sku}::${supplierId}`
}

export type DesignLineInput = {
  index: number
  sku: string | null
  isNonProduct: boolean
  requiresDesign: boolean
  resolvedSupplierId: string | null
  existingDesignLink: string | null
}

export type LibraryEntry = { ready: boolean; designLink: string | null }
export type LibraryLookup = (sku: string, supplierId: string) => LibraryEntry | null

export type DesignResolution = {
  orderDesignReady: boolean
  lineLinks: Array<{ index: number; designLink: string }>
  missing: Array<{ index: number; sku: string | null; supplierId: string | null }>
}

export function resolveOrderDesign(lines: DesignLineInput[], lookup: LibraryLookup): DesignResolution {
  const designLines = lines.filter(l => !l.isNonProduct && l.requiresDesign)
  const lineLinks: DesignResolution['lineLinks'] = []
  const missing: DesignResolution['missing'] = []
  let orderDesignReady = true

  for (const line of designLines) {
    if (line.existingDesignLink) continue
    const entry = line.sku && line.resolvedSupplierId ? lookup(line.sku, line.resolvedSupplierId) : null
    if (entry && entry.ready) {
      if (entry.designLink) lineLinks.push({ index: line.index, designLink: entry.designLink })
      continue
    }
    orderDesignReady = false
    missing.push({ index: line.index, sku: line.sku, supplierId: line.resolvedSupplierId })
  }

  return { orderDesignReady, lineLinks, missing }
}

export type DesignImportRow = { sku: string; supplierCode: string; designLink: string }

export function parseDesignLibraryCsv(text: string): { rows: DesignImportRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const rows: DesignImportRow[] = []
  const errors: string[] = []
  if (lines.length === 0) return { rows, errors }

  const header = lines[0].split(',').map(h => h.trim())
  const iSku = header.indexOf('sku')
  const iSup = header.indexOf('supplierCode')
  const iLink = header.indexOf('designLink')
  if (iSku < 0 || iSup < 0 || iLink < 0) {
    return { rows, errors: ['Header must contain: sku, supplierCode, designLink'] }
  }

  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split(',').map(c => c.trim())
    const sku = cells[iSku] ?? ''
    const supplierCode = cells[iSup] ?? ''
    const designLink = cells[iLink] ?? ''
    if (!sku || !supplierCode || !designLink) {
      errors.push(`Line ${i + 1}: missing sku/supplierCode/designLink`)
      continue
    }
    rows.push({ sku, supplierCode, designLink })
  }
  return { rows, errors }
}
