import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { TooLargeError, libraryTmpDir, type TempFile } from '@/lib/library-storage'

export type MultipartFile = TempFile & { field: string; fileName: string | null; contentType: string | null }
export type MultipartResult = { files: MultipartFile[]; fields: Record<string, string> }

export class MultipartError extends Error {}

const MAX_HEADER_BYTES = 16 * 1024
const HEAD_BYTES = 64

function boundaryOf(contentType: string | null): string {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '')
  const b = m?.[1] ?? m?.[2]
  if (!contentType?.toLowerCase().startsWith('multipart/form-data') || !b) throw new MultipartError('Cần multipart/form-data')
  return b
}

function parseHeaders(block: string) {
  let name: string | null = null, fileName: string | null = null, contentType: string | null = null
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'content-disposition') {
      name = /\bname="([^"]*)"/i.exec(value)?.[1] ?? /\bname=([^;\s]+)/i.exec(value)?.[1] ?? null
      fileName = /\bfilename="([^"]*)"/i.exec(value)?.[1] ?? /\bfilename=([^;\s]+)/i.exec(value)?.[1] ?? null
    } else if (key === 'content-type') {
      contentType = value
    }
  }
  if (!name) throw new MultipartError('Part thiếu name')
  return { name, fileName, contentType }
}

type Sink = {
  write(chunk: Buffer): Promise<void>
  finish(): Promise<void>
}

export async function parseMultipartToTemp(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  opts: { maxFileBytes: number; maxFieldBytes: number; maxParts?: number; inMemory?: (name: string, fileName: string | null, contentType: string | null) => boolean },
): Promise<MultipartResult> {
  if (!body) throw new MultipartError('Body rỗng')
  const boundary = boundaryOf(contentType)
  const dashBoundary = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const maxParts = opts.maxParts ?? 10
  const files: MultipartFile[] = []
  const fields: Record<string, string> = {}
  let partCount = 0
  let state: 'preamble' | 'after' | 'headers' | 'body' | 'end' = 'preamble'
  let buf = Buffer.alloc(0)
  let sink: Sink | null = null
  const streams: fs.WriteStream[] = []

  async function openPart(headerBlock: string): Promise<Sink> {
    const { name, fileName, contentType: ct } = parseHeaders(headerBlock)
    if (++partCount > maxParts) throw new MultipartError('Quá nhiều part')
    const memory = !fileName || (opts.inMemory?.(name, fileName, ct) ?? false)
    if (memory) {
      const chunks: Buffer[] = []
      let size = 0
      return {
        async write(chunk) {
          size += chunk.length
          if (size > opts.maxFieldBytes) throw new TooLargeError(`Part ${name} quá lớn`)
          chunks.push(chunk)
        },
        async finish() { fields[name] = Buffer.concat(chunks).toString('utf8') },
      }
    }
    await fsp.mkdir(libraryTmpDir(), { recursive: true })
    const tmpPath = path.join(libraryTmpDir(), `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`)
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' })
    streams.push(out)
    const entry: MultipartFile = { field: name, fileName, contentType: ct, tmpPath, size: 0, sha256: '', head: Buffer.alloc(0) }
    files.push(entry)
    const hash = crypto.createHash('sha256')
    let failed: Error | null = null
    out.on('error', e => { failed = e })
    return {
      async write(chunk) {
        if (failed) throw failed
        entry.size += chunk.length
        if (entry.size > opts.maxFileBytes) throw new TooLargeError(`File ${fileName} quá lớn`)
        if (entry.head.length < HEAD_BYTES) entry.head = Buffer.concat([entry.head, chunk.subarray(0, HEAD_BYTES - entry.head.length)])
        hash.update(chunk)
        if (!out.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            const done = (e?: Error) => { out.off('drain', done); out.off('error', done); if (e) reject(e); else resolve() }
            out.on('drain', done)
            out.on('error', done)
          })
        }
      },
      async finish() {
        await new Promise<void>((resolve, reject) => { out.end((e?: Error | null) => (e ? reject(e) : resolve())) })
        if (failed) throw failed
        entry.sha256 = hash.digest('hex')
      },
    }
  }

  async function drain(final: boolean) {
    for (;;) {
      if (state === 'end') { buf = Buffer.alloc(0); return }
      if (state === 'preamble') {
        const i = buf.indexOf(dashBoundary)
        if (i < 0) { buf = buf.subarray(Math.max(0, buf.length - dashBoundary.length)); return }
        buf = buf.subarray(i + dashBoundary.length)
        state = 'after'
      } else if (state === 'after') {
        if (buf.length < 2) return
        const two = buf.toString('latin1', 0, 2)
        if (two === '--') { state = 'end'; continue }
        if (two !== '\r\n') throw new MultipartError('Multipart sai định dạng')
        buf = buf.subarray(2)
        state = 'headers'
      } else if (state === 'headers') {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) {
          if (buf.length > MAX_HEADER_BYTES) throw new MultipartError('Header part quá dài')
          return
        }
        sink = await openPart(buf.toString('utf8', 0, i))
        buf = buf.subarray(i + 4)
        state = 'body'
      } else {
        const i = buf.indexOf(delimiter)
        if (i < 0) {
          const safe = final ? 0 : buf.length - (delimiter.length - 1)
          if (safe > 0) {
            await sink!.write(buf.subarray(0, safe))
            buf = buf.subarray(safe)
          }
          return
        }
        if (i > 0) await sink!.write(buf.subarray(0, i))
        await sink!.finish()
        sink = null
        buf = buf.subarray(i + delimiter.length)
        state = 'after'
      }
    }
  }

  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf = buf.length ? Buffer.concat([buf, Buffer.from(value)]) : Buffer.from(value)
      await drain(false)
    }
    await drain(true)
    if ((state as string) !== 'end') throw new MultipartError('Multipart không đầy đủ')
    return { files, fields }
  } catch (e) {
    await reader.cancel().catch(() => {})
    await Promise.all(streams.filter(s => !s.closed).map(s => new Promise<void>(resolve => { s.once('close', () => resolve()); s.destroy() })))
    await cleanupMultipart({ files, fields })
    throw e
  }
}

export async function cleanupMultipart(r: MultipartResult | null) {
  if (!r) return
  for (const f of r.files) await fsp.rm(f.tmpPath, { force: true }).catch(() => {})
}
