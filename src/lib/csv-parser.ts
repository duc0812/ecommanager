export function parseCsv(input: string): Record<string, string>[] {
  // Normalize line endings
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows = parseRows(text)
  if (rows.length === 0) return []
  const headers = rows[0]
  const records: Record<string, string>[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.length === 1 && row[0] === '') continue  // skip blank lines
    const rec: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = row[c] ?? ''
    }
    records.push(rec)
  }
  return records
}

function parseRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++; continue
    }
    field += ch; i++
  }
  // last field/row
  if (field !== '' || row.length > 0) {
    row.push(field); rows.push(row)
  }
  return rows
}
