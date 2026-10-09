import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { MultipartError, parseMultipartToTemp } from '@/lib/multipart-stream'
import { TooLargeError, streamToTempFile } from '@/lib/library-storage'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-storage-'))

function chunked(buf: Buffer, size: number): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= buf.length) { controller.close(); return }
      controller.enqueue(new Uint8Array(buf.subarray(at, at + size)))
      at += size
    },
  })
}

async function multipartBody(parts: Array<{ name: string; fileName?: string; type?: string; data: Buffer | string }>) {
  const fd = new FormData()
  for (const p of parts) {
    if (p.fileName) fd.append(p.name, new Blob([new Uint8Array(Buffer.from(p.data))], { type: p.type ?? 'application/octet-stream' }), p.fileName)
    else fd.append(p.name, String(p.data))
  }
  const res = new Response(fd)
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type')! }
}

beforeAll(() => { process.env.DESIGN_STORAGE_DIR = tmp })
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('parseMultipartToTemp', () => {
  it('writes file parts to disk and keeps text parts in memory, across tiny chunks', async () => {
    const big = crypto.randomBytes(200_000)
    const { body, contentType } = await multipartBody([
      { name: 'result', fileName: 'result.json', type: 'application/json', data: '{"a":1}' },
      { name: 'artwork', fileName: 'artwork.png', type: 'image/png', data: big },
      { name: 'note', data: 'hello' },
    ])
    for (const size of [7, 4096, body.length]) {
      const r = await parseMultipartToTemp(chunked(body, size), contentType, {
        maxFileBytes: 1_000_000, maxFieldBytes: 1000, inMemory: (n, f) => n === 'result' || !!f?.endsWith('.json'),
      })
      expect(r.fields).toEqual({ result: '{"a":1}', note: 'hello' })
      expect(r.files).toHaveLength(1)
      const f = r.files[0]
      expect(f).toMatchObject({ field: 'artwork', fileName: 'artwork.png', contentType: 'image/png', size: big.length })
      expect(fs.readFileSync(f.tmpPath).equals(big)).toBe(true)
      expect(f.sha256).toBe(crypto.createHash('sha256').update(big).digest('hex'))
      fs.rmSync(f.tmpPath)
    }
  })

  it('aborts a file part over the cap and removes its temp file', async () => {
    const { body, contentType } = await multipartBody([{ name: 'artwork', fileName: 'a.png', data: Buffer.alloc(5000, 1) }])
    await expect(parseMultipartToTemp(chunked(body, 512), contentType, { maxFileBytes: 1000, maxFieldBytes: 100 })).rejects.toBeInstanceOf(TooLargeError)
    expect(fs.readdirSync(path.join(tmp, 'tmp'))).toEqual([])
  })

  it('rejects a truncated body and a non-multipart content type', async () => {
    const { body, contentType } = await multipartBody([{ name: 'artwork', fileName: 'a.png', data: Buffer.alloc(100, 1) }])
    await expect(parseMultipartToTemp(chunked(body.subarray(0, body.length - 20), 64), contentType, { maxFileBytes: 1000, maxFieldBytes: 100 })).rejects.toBeInstanceOf(MultipartError)
    await expect(parseMultipartToTemp(chunked(body, 64), 'application/json', { maxFileBytes: 1000, maxFieldBytes: 100 })).rejects.toBeInstanceOf(MultipartError)
    expect(fs.readdirSync(path.join(tmp, 'tmp'))).toEqual([])
  })
})

describe('streamToTempFile', () => {
  it('streams to disk with size, hash and head', async () => {
    const data = Buffer.concat([Buffer.from('8BPS'), crypto.randomBytes(10_000)])
    const t = await streamToTempFile(chunked(data, 333), 20_000)
    expect(t.size).toBe(data.length)
    expect(t.head.subarray(0, 4).toString()).toBe('8BPS')
    expect(fs.readFileSync(t.tmpPath).equals(data)).toBe(true)
    fs.rmSync(t.tmpPath)
  })

  it('stops past the cap and leaves no temp file', async () => {
    await expect(streamToTempFile(chunked(Buffer.alloc(10_000), 1000), 4000)).rejects.toBeInstanceOf(TooLargeError)
    expect(fs.readdirSync(path.join(tmp, 'tmp'))).toEqual([])
  })
})
