export const PGPRINTS_SUPPLIER_KEY = 'pgprints'

export function isPgprintsSupplier(s: { code?: string | null; apiType?: string | null } | null | undefined): boolean {
  if (!s) return false
  return (s.code ?? '').trim().toLowerCase() === PGPRINTS_SUPPLIER_KEY || (s.apiType ?? '').trim().toLowerCase() === PGPRINTS_SUPPLIER_KEY
}

export type PushStatus = 'SENDING' | 'CREATED' | 'FAILED' | 'CANCELLED'

export type PushView = {
  id: string
  status: PushStatus
  externalOrderId: string
  supplierOrderCode: string | null
  remoteStatus: string | null
  totalCost: number | null
  shippingFee: number | null
  handleFee: number | null
  error: string | null
  pushedAt: string
  pushedByName: string | null
  cancelledAt: string | null
  lastSyncedAt: string | null
}

export type PreviewIssue = { level: 'error' | 'warning'; code: string; message: string; refId?: string }

export type PreviewFile = {
  area: string
  artworkId: string | null
  fileName: string | null
  mimeType: string | null
  widthPx: number | null
  heightPx: number | null
  expectedWidthPx: number | null
  expectedHeightPx: number | null
  sizeOk: boolean | null
  publicUrl: string | null
  viewUrl: string | null
  thumbUrl: string | null
}

export type PreviewLine = {
  refId: string
  lineId: string
  linePosition: number
  productTitle: string
  variantTitle: string | null
  quantity: number
  supplierSku: string | null
  apiSku: string | null
  shipClass: string | null
  shipClassSource: 'product' | 'default' | null
  shipCountries: string[]
  templateName: string | null
  mockupUrl: string | null
  designNote: string | null
  files: PreviewFile[]
}

export type PushPreview = {
  order: { id: string; shopifyOrderNumber: string; pipelineStatus: string; storeName: string }
  supplier: { id: string; name: string; code: string } | null
  pushEnabled: boolean
  hasCredentials: boolean
  canPush: boolean
  payload: unknown | null
  payloadHash: string | null
  lines: PreviewLine[]
  issues: PreviewIssue[]
  balance: { availableAmount: number; pendingAmount: number; paidAmount: number; upcomingAmount: number } | null
  activePush: PushView | null
  history: PushView[]
}

/** "us, ca" → ["US", "CA"]; an empty list means the SKU ships anywhere. */
export function parseShipCountries(value: string | null | undefined): string[] {
  const out: string[] = []
  for (const raw of (value ?? '').split(/[\s,;]+/)) {
    const code = raw.trim().toUpperCase()
    if (/^[A-Z]{2}$/.test(code) && !out.includes(code)) out.push(code)
  }
  return out
}

export function normalizeShipCountries(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'Nước giao tới phải là danh sách mã quốc gia 2 chữ, cách nhau bằng dấu phẩy' }
  const tokens = value.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)
  const bad = tokens.filter(t => !/^[A-Za-z]{2}$/.test(t))
  if (bad.length > 0) return { ok: false, error: `Mã quốc gia không hợp lệ: ${bad.join(', ')} — dùng mã ISO 2 chữ (US, CA, GB…)` }
  const codes = parseShipCountries(tokens.join(','))
  return { ok: true, value: codes.length > 0 ? codes.join(',') : null }
}
