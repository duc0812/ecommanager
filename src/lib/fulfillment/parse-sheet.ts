export type SheetRef = { spreadsheetId: string; gid: string }

export function parseSheetUrl(url: string): SheetRef | null {
  const id = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1]
  if (!id) return null
  const gid = url.match(/[?#&]gid=([0-9]+)/)?.[1] ?? '0'
  return { spreadsheetId: id, gid }
}

export function csvExportUrl(ref: SheetRef): string {
  return `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/export?format=csv&gid=${ref.gid}`
}

export type SheetRow = { orderToken: string; tracking: string }

function splitCsvLine(line: string): string[] {
  // Sheet data has no embedded commas/quotes, but tolerate simple quoted cells.
  return line.split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1').trim())
}

export function parseSheetCsv(text: string): SheetRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length === 0) return []
  const first = splitCsvLine(lines[0]).map(c => c.toLowerCase())
  const hasHeader = first.some(c => c.includes('order')) && first.some(c => c.includes('track'))
  let orderCol = 0
  let trackCol = -1 // last column
  let start = 0
  if (hasHeader) {
    orderCol = first.findIndex(c => c.includes('order'))
    trackCol = first.findIndex(c => c.includes('track'))
    start = 1
  }
  const seen = new Set<string>()
  const out: SheetRow[] = []
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const orderToken = (cells[orderCol] ?? '').trim()
    const tracking = (trackCol === -1 ? cells[cells.length - 1] : cells[trackCol] ?? '').trim()
    if (!orderToken || !tracking) continue
    const key = `${orderToken} ${tracking}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ orderToken, tracking })
  }
  return out
}

export async function fetchSheetCsv(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Không tải được sheet (HTTP ${res.status}). Kiểm tra link và quyền chia sẻ.`)
  const text = await res.text()
  if (/<html|<!doctype html/i.test(text.slice(0, 200))) {
    throw new Error('Sheet chưa bật "Anyone with the link → Viewer" (nhận về trang HTML thay vì CSV).')
  }
  return text
}
