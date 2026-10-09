const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const NO_LENGTH_MARKERS = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7])

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  return { width, height }
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null
    let j = i + 1
    while (j < bytes.length && bytes[j] === 0xff) j++
    if (j >= bytes.length) return null
    const marker = bytes[j]
    const segStart = j - 1
    if (NO_LENGTH_MARKERS.has(marker)) {
      i = j + 1
      continue
    }
    if (j + 2 >= bytes.length) return null
    const length = bytes.readUInt16BE(j + 1)
    if (SOF_MARKERS.has(marker)) {
      if (segStart + 8 >= bytes.length) return null
      const height = bytes.readUInt16BE(segStart + 5)
      const width = bytes.readUInt16BE(segStart + 7)
      return { width, height }
    }
    i = j + 1 + length
  }
  return null
}

export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  try {
    if (!bytes || bytes.length === 0) return null
    const png = pngSize(bytes)
    if (png) return png
    return jpegSize(bytes)
  } catch {
    return null
  }
}
