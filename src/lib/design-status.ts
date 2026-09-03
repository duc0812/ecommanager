// Per-line design status for the Orders "Design" column, so mixed orders (e.g.
// one truly-customized line + one custom-SKU-but-not-customized line) each show
// an accurate status. `previewCdnUrl` presence marks a line the customer actually
// customized (→ Trello flow); otherwise a ready Design Library entry covers it.

export type LineDesignStatus = 'DONE' | 'PENDING' | 'LIBRARY' | 'NONE'

export const DESIGN_STATUS_META: Record<LineDesignStatus, { label: string; tone: string }> = {
  DONE: { label: 'Done', tone: 'bg-tertiary/15 text-tertiary' },
  PENDING: { label: 'Chờ design', tone: 'bg-amber-100 text-amber-900' },
  LIBRARY: { label: 'Design Library', tone: 'bg-secondary/10 text-secondary' },
  NONE: { label: '—', tone: 'text-on-surface-variant' },
}

export function lineDesignStatus(input: {
  isNonProduct: boolean
  previewCdnUrl?: string | null
  designDriveLink?: string | null
  hasLibraryDesign: boolean
  customized?: boolean
}): LineDesignStatus {
  if (input.isNonProduct) return 'NONE'
  if (input.designDriveLink) return 'DONE'
  const isCustomized = input.customized ?? !!input.previewCdnUrl
  if (isCustomized) return 'PENDING'
  if (input.hasLibraryDesign) return 'LIBRARY'
  return 'NONE'
}
