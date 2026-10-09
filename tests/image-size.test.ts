import { describe, it, expect } from 'vitest'
import { imageSize } from '@/lib/image-size'

function pngBuffer(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(13, 0)
  const type = Buffer.from('IHDR', 'ascii')
  const w = Buffer.alloc(4)
  w.writeUInt32BE(width, 0)
  const h = Buffer.alloc(4)
  h.writeUInt32BE(height, 0)
  const rest = Buffer.from([8, 6, 0, 0, 0])
  const crc = Buffer.alloc(4)
  return Buffer.concat([sig, length, type, w, h, rest, crc])
}

function jpegBuffer(width: number, height: number): Buffer {
  const w = Buffer.alloc(2)
  w.writeUInt16BE(width, 0)
  const h = Buffer.alloc(2)
  h.writeUInt16BE(height, 0)
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x11, 0x08, h[0], h[1], w[0], w[1], 0x03,
  ])
}

describe('imageSize', () => {
  it('reads width/height from a PNG IHDR chunk', () => {
    expect(imageSize(pngBuffer(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads width/height from a JPEG SOF0 marker', () => {
    expect(imageSize(jpegBuffer(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('reads width/height from a JPEG SOF2 (progressive) marker', () => {
    const buf = jpegBuffer(640, 480)
    buf[7] = 0xc2
    expect(imageSize(buf)).toEqual({ width: 640, height: 480 })
  })

  it('returns null for random bytes', () => {
    expect(imageSize(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull()
  })

  it('never throws on short or odd buffers', () => {
    expect(imageSize(Buffer.alloc(0))).toBeNull()
    expect(imageSize(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull()
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
  })
})
