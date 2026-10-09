export type FontNames = { postscriptName: string; family: string; style: string; fullName: string | null }

export class FontParseError extends Error {}

const TAG_TTC = 0x74746366
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031])
const MAX_TTC_FONTS = 64

function u16(buf: Buffer, at: number): number {
  if (at < 0 || at + 2 > buf.length) throw new FontParseError('File font bị cắt ngắn')
  return buf.readUInt16BE(at)
}

function u32(buf: Buffer, at: number): number {
  if (at < 0 || at + 4 > buf.length) throw new FontParseError('File font bị cắt ngắn')
  return buf.readUInt32BE(at)
}

function decodeUtf16be(bytes: Buffer): string {
  const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
  swapped.swap16()
  return swapped.toString('utf16le')
}

type NameRecord = { platformId: number; encodingId: number; languageId: number; nameId: number; value: string }

function readNameTable(buf: Buffer, start: number, length: number): NameRecord[] {
  const end = start + length
  if (end > buf.length) throw new FontParseError('Bảng name vượt quá file')
  const count = u16(buf, start + 2)
  const stringBase = start + u16(buf, start + 4)
  const out: NameRecord[] = []
  for (let i = 0; i < count; i++) {
    const r = start + 6 + i * 12
    if (r + 12 > end) break
    const platformId = u16(buf, r), encodingId = u16(buf, r + 2), languageId = u16(buf, r + 4), nameId = u16(buf, r + 6)
    const len = u16(buf, r + 8), off = u16(buf, r + 10)
    const s = stringBase + off
    if (s + len > end) continue
    const bytes = buf.subarray(s, s + len)
    let value: string
    if (platformId === 0 || platformId === 3) value = decodeUtf16be(bytes)
    else if (platformId === 1 && encodingId === 0) value = bytes.toString('latin1')
    else continue
    value = value.replace(/\0/g, '').trim()
    if (value) out.push({ platformId, encodingId, languageId, nameId, value })
  }
  return out
}

function pick(records: NameRecord[], nameId: number): string | null {
  const rank = (r: NameRecord) => {
    if (r.platformId === 3 && r.languageId === 0x409) return 0
    if (r.platformId === 3) return 1
    if (r.platformId === 0) return 2
    if (r.platformId === 1 && r.languageId === 0) return 3
    return 4
  }
  const matches = records.filter(r => r.nameId === nameId).sort((a, b) => rank(a) - rank(b))
  return matches[0]?.value ?? null
}

function namesAt(buf: Buffer, offset: number): FontNames {
  const version = u32(buf, offset)
  if (!SFNT_VERSIONS.has(version)) throw new FontParseError('Không phải file font TrueType/OpenType')
  const numTables = u16(buf, offset + 4)
  let records: NameRecord[] | null = null
  for (let i = 0; i < numTables; i++) {
    const r = offset + 12 + i * 16
    if (buf.toString('latin1', r, r + 4) !== 'name') { u32(buf, r + 12); continue }
    records = readNameTable(buf, u32(buf, r + 8), u32(buf, r + 12))
    break
  }
  if (!records) throw new FontParseError('Font không có bảng name')
  const fullName = pick(records, 4)
  const postscript = (pick(records, 6) ?? fullName ?? '').replace(/[^\x21-\x7e]/g, '')
  if (!postscript) throw new FontParseError('Font không có postscript name')
  const family = pick(records, 16) ?? pick(records, 1) ?? postscript
  const style = pick(records, 17) ?? pick(records, 2) ?? 'Regular'
  return { postscriptName: postscript, family, style, fullName }
}

export function parseFontNames(buf: Buffer): FontNames[] {
  if (buf.length < 12) throw new FontParseError('File font quá nhỏ')
  if (u32(buf, 0) === TAG_TTC) {
    const count = u32(buf, 8)
    if (count === 0 || count > MAX_TTC_FONTS) throw new FontParseError('Font collection không hợp lệ')
    const out: FontNames[] = []
    for (let i = 0; i < count; i++) out.push(namesAt(buf, u32(buf, 12 + i * 4)))
    return out
  }
  return [namesAt(buf, 0)]
}

export function parseFontName(buf: Buffer): FontNames {
  return parseFontNames(buf)[0]
}
