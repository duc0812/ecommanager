export type CustomAttribute = { key: string; value: string }
export type DriveAttachment = { url: string; name: string }

export function extractPreviewCdnUrl(attrs: CustomAttribute[]): string | null {
  const direct = attrs.find(a => a.key === '_customall_preview')?.value
  if (direct) return direct

  const byLabel = attrs.find(a => /preview/i.test(a.key) && /^https?:\/\//i.test(a.value))?.value
  return byLabel ?? null
}

function normalizedOrderToken(orderNumber: string): string {
  return orderNumber.replace(/^#/, '').toLowerCase().trim()
}

export function findDriveAttachmentForLine(
  orderNumber: string,
  lineNumber: number,
  sku: string | null | undefined,
  attachments: DriveAttachment[],
  productLineCount: number,
): DriveAttachment | null {
  const driveAttachments = attachments.filter(a => a.url.includes('drive.google.com'))
  if (driveAttachments.length === 0) return null

  const orderToken = normalizedOrderToken(orderNumber)
  const indexedToken = `${orderToken}_${lineNumber}`
  const indexed = driveAttachments.find(a => {
    const haystack = `${a.name} ${a.url}`.toLowerCase()
    return haystack.includes(indexedToken) || haystack.includes(`#${indexedToken}`)
  })
  if (indexed) return indexed

  const normalizedSku = (sku ?? '').toLowerCase().trim()
  if (normalizedSku) {
    const matched = driveAttachments.find(a => {
      const haystack = `${a.name} ${a.url}`.toLowerCase()
      return haystack.includes(normalizedSku)
    })
    if (matched) return matched
  }

  if (productLineCount === 1 && driveAttachments.length === 1) return driveAttachments[0]
  return null
}
