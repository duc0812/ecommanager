function utf16be(s: string): Buffer {
  const b = Buffer.from(s, 'utf16le')
  b.swap16()
  return b
}

function nameTable(names: Record<number, string>, platform: 'win' | 'mac'): Buffer {
  const entries = Object.entries(names).map(([id, value]) => ({ id: Number(id), bytes: platform === 'win' ? utf16be(value) : Buffer.from(value, 'latin1') }))
  const header = Buffer.alloc(6 + entries.length * 12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(entries.length, 2)
  header.writeUInt16BE(header.length, 4)
  let offset = 0
  entries.forEach((e, i) => {
    const r = 6 + i * 12
    header.writeUInt16BE(platform === 'win' ? 3 : 1, r)
    header.writeUInt16BE(platform === 'win' ? 1 : 0, r + 2)
    header.writeUInt16BE(platform === 'win' ? 0x409 : 0, r + 4)
    header.writeUInt16BE(e.id, r + 6)
    header.writeUInt16BE(e.bytes.length, r + 8)
    header.writeUInt16BE(offset, r + 10)
    offset += e.bytes.length
  })
  return Buffer.concat([header, ...entries.map(e => e.bytes)])
}

function sfnt(names: Record<number, string>, base: number, platform: 'win' | 'mac'): Buffer {
  const table = nameTable(names, platform)
  const dummy = Buffer.alloc(8, 1)
  const head = Buffer.alloc(12 + 2 * 16)
  head.writeUInt32BE(0x00010000, 0)
  head.writeUInt16BE(2, 4)
  head.writeUInt16BE(32, 6)
  head.writeUInt16BE(1, 8)
  head.writeUInt16BE(0, 10)
  head.write('head', 12, 'latin1')
  head.writeUInt32BE(base + head.length, 12 + 8)
  head.writeUInt32BE(dummy.length, 12 + 12)
  head.write('name', 28, 'latin1')
  head.writeUInt32BE(base + head.length + dummy.length, 28 + 8)
  head.writeUInt32BE(table.length, 28 + 12)
  return Buffer.concat([head, dummy, table])
}

export function buildTtf(names: Record<number, string>, platform: 'win' | 'mac' = 'win'): Buffer {
  return sfnt(names, 0, platform)
}

export function buildTtc(fonts: Record<number, string>[]): Buffer {
  const headerLen = 12 + fonts.length * 4
  const header = Buffer.alloc(headerLen)
  header.write('ttcf', 0, 'latin1')
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(0, 6)
  header.writeUInt32BE(fonts.length, 8)
  const parts: Buffer[] = []
  let at = headerLen
  fonts.forEach((names, i) => {
    header.writeUInt32BE(at, 12 + i * 4)
    const f = sfnt(names, at, 'win')
    parts.push(f)
    at += f.length
  })
  return Buffer.concat([header, ...parts])
}
