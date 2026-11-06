import { assertSafeExternalUrl } from '@/lib/safe-url'
export type SheetRef = { spreadsheetId: string; gid: string | null }

export function parseSheetUrl(url: string): SheetRef | null {
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1]
  if (!id) return null
  // A "/edit?usp=sharing" link carries no gid. Do NOT default to gid=0 — a sheet
  // whose original first tab was deleted has no gid 0, and export?gid=0 then 400s.
  // gid=null → omit it below so Google exports the first existing sheet.
  const gid = url.match(/[?#&]gid=([0-9]+)/)?.[1] ?? null
  return { spreadsheetId: id, gid }
}

export function csvExportUrl(ref: SheetRef): string {
  const base = `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/export?format=csv`
  return ref.gid ? `${base}&gid=${ref.gid}` : base
}

// byOrderNumber: the sheet wrote the bare order number and the token is the line key from its Order Vendor column.
export type SheetRow = { orderToken: string; tracking: string; byOrderNumber?: boolean }

function splitCsvLine(line: string): string[] {
  // Sheet data has no embedded commas/quotes, but tolerate simple quoted cells.
  return line.split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1').trim())
}

// The Mangoshao channel writes Order Number = the bare order number and Order Vendor = the line key; Jomall writes the
// line key in Order Number. The vendor's key is taken only when it is a line key of that same order.
const VENDOR_HEADER = 'order vendor'
// Any sub-order suffix, as normalizeBaseOrder strips it: an order cell carrying one is not the bare order number.
const ANY_SUFFIX = /(_[A-Za-z0-9]+)+$/
// A line key numbers product lines ("_2", "_2_1"); a letter suffix ("_US", "_R2") names no line.
const LINE_SUFFIX = /(_\d+)+$/

function lineKeyFromVendor(orderCell: string, vendorCell: string): string | null {
  const order = orderCell.trim().replace(/^#/, '')
  const vendor = vendorCell.trim().replace(/^#/, '')
  if (!order || ANY_SUFFIX.test(order)) return null
  const suffix = vendor.match(LINE_SUFFIX)?.[0]
  if (!suffix || vendor.slice(0, -suffix.length).toUpperCase() !== order.toUpperCase()) return null
  return `${order}${suffix}`
}

export function parseSheetCsv(text: string): SheetRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const first = splitCsvLine(lines[0]).map(c => c.toLowerCase())
  const hasHeader = first.some(c => c.includes('order')) && first.some(c => c.includes('track'))
  let orderCol = 0
  let trackCol = -1 // last column
  let vendorCol = -1
  let start = 0
  if (hasHeader) {
    orderCol = first.findIndex(c => c.includes('order'))
    trackCol = first.findIndex(c => c.includes('track'))
    vendorCol = first.indexOf(VENDOR_HEADER)
    if (vendorCol === orderCol) vendorCol = -1
    start = 1
  }
  const seen = new Set<string>()
  const out: SheetRow[] = []
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const orderCell = (cells[orderCol] ?? '').trim()
    const tracking = (trackCol === -1 ? cells[cells.length - 1] : cells[trackCol] ?? '').trim()
    if (!orderCell || !tracking) continue
    const fromVendor = vendorCol >= 0 ? lineKeyFromVendor(orderCell, cells[vendorCol] ?? '') : null
    const orderToken = fromVendor ?? orderCell
    const key = `${orderToken} ${tracking}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fromVendor ? { orderToken, tracking, byOrderNumber: true } : { orderToken, tracking })
  }
  return out
}

export async function fetchSheetCsv(url: string): Promise<string> {
  const safe = assertSafeExternalUrl(url, { allowedHosts: ['docs.google.com', 'googleusercontent.com', 'drive.google.com'] })
  const res = await fetch(safe.toString(), { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Không tải được sheet (HTTP ${res.status}). Kiểm tra: link đúng, sheet đã chia sẻ "Anyone with the link → Viewer", và đúng tab.`)
  const text = await res.text()
  if (/<html|<!doctype html/i.test(text.slice(0, 200))) {
    throw new Error('Sheet chưa bật "Anyone with the link → Viewer" (nhận về trang HTML thay vì CSV).')
  }
  return text
}
