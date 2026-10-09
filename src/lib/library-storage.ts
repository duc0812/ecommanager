import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { safeFileName, storageRoot } from '@/lib/design-storage'
import { DriveAuthError, DriveError, streamFile } from '@/lib/google-drive'

export type LibraryKind = 'PSD' | 'ARTWORK' | 'PREVIEW' | 'FONT'

export class TooLargeError extends Error {}

export type TempFile = { tmpPath: string; size: number; sha256: string; head: Buffer }

const HEAD_BYTES = 64
const DRIVE_WEB_PREFIX = 'https://drive.google.com/'

export function libraryTmpDir(): string {
  return path.join(path.resolve(storageRoot()), 'tmp')
}

function tmpName(): string {
  return path.join(libraryTmpDir(), `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.part`)
}

export async function streamToTempFile(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<TempFile> {
  if (!body) throw new Error('Body rỗng')
  await fsp.mkdir(libraryTmpDir(), { recursive: true })
  const tmpPath = tmpName()
  const hash = crypto.createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > maxBytes) { cb(new TooLargeError(`File lớn hơn ${Math.round(maxBytes / 1048576)} MB`)); return }
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)])
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>), meter, fs.createWriteStream(tmpPath, { flags: 'wx' }))
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {})
    throw e
  }
  return { tmpPath, size, sha256: hash.digest('hex'), head }
}

export async function hashFile(absPath: string): Promise<{ size: number; sha256: string }> {
  const hash = crypto.createHash('sha256')
  let size = 0
  await pipeline(fs.createReadStream(absPath), new Transform({
    transform(chunk: Buffer, _enc, cb) { size += chunk.length; hash.update(chunk); cb() },
  }))
  return { size, sha256: hash.digest('hex') }
}

export function localLibraryPath(storagePath: string | null): string | null {
  if (!storagePath) return null
  const root = path.resolve(storageRoot())
  const abs = path.resolve(root, storagePath)
  return abs.startsWith(root + path.sep) ? abs : null
}

async function usableCopy(kind: LibraryKind, sha256: string) {
  const rows = await prisma.libraryFile.findMany({ where: { kind, sha256 }, orderBy: { createdAt: 'desc' } })
  for (const row of rows) {
    if (row.storage === 'DRIVE' && row.driveFileId) return row
    const abs = localLibraryPath(row.storagePath)
    if (abs && await fsp.stat(abs).then(s => s.isFile() && s.size === row.size, () => false)) return row
  }
  return null
}

export async function storeLibraryFile(input: {
  temp: TempFile; kind: LibraryKind; fileName: string; mimeType: string; relDir: string[]; uploadedById: string | null
}) {
  const { temp } = input
  const existing = await usableCopy(input.kind, temp.sha256)
  if (existing) {
    await fsp.rm(temp.tmpPath, { force: true }).catch(() => {})
    return { file: existing, reused: true }
  }
  const root = path.resolve(storageRoot())
  const fileName = safeFileName(input.fileName)
  const rel = path.join('library', ...input.relDir.map(s => safeFileName(s)), `${temp.sha256.slice(0, 12)}-${fileName}`)
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage path')
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.rm(abs, { force: true })
  try {
    await fsp.rename(temp.tmpPath, abs)
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e
    await fsp.copyFile(temp.tmpPath, abs)
    await fsp.rm(temp.tmpPath, { force: true })
  }
  const file = await prisma.libraryFile.create({
    data: {
      kind: input.kind, fileName, mimeType: input.mimeType, size: temp.size, sha256: temp.sha256,
      storage: 'LOCAL', storagePath: rel.split(path.sep).join('/'), uploadedById: input.uploadedById,
    },
  })
  return { file, reused: false }
}

export async function discardTemp(temp: TempFile | null) {
  if (temp) await fsp.rm(temp.tmpPath, { force: true }).catch(() => {})
}

type ServableFile = {
  fileName: string; mimeType: string; size: number; storage: string; storagePath: string | null
  driveFileId: string | null; driveWebViewLink: string | null
}

function headersFor(row: ServableFile, disposition: 'inline' | 'attachment', length?: number): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': row.mimeType,
    'Content-Disposition': `${disposition}; filename="${safeFileName(row.fileName)}"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  }
  if (length !== undefined) h['Content-Length'] = String(length)
  return h
}

export async function serveLibraryFile(row: ServableFile, opts: { disposition: 'inline' | 'attachment'; redirectDrive?: boolean }): Promise<NextResponse> {
  if (row.storage === 'DRIVE') {
    if (opts.redirectDrive) {
      if (!row.driveWebViewLink?.startsWith(DRIVE_WEB_PREFIX)) return NextResponse.json({ error: 'Thiếu link Drive' }, { status: 404 })
      return NextResponse.redirect(row.driveWebViewLink, 302)
    }
    if (!row.driveFileId) return NextResponse.json({ error: 'Thiếu file Drive' }, { status: 404 })
    try {
      const res = await streamFile(row.driveFileId)
      return new NextResponse(res.body, { headers: headersFor(row, opts.disposition) })
    } catch (err: any) {
      if (err instanceof DriveAuthError) return NextResponse.json({ error: 'Google Drive cần kết nối lại' }, { status: 502 })
      if (err instanceof DriveError && err.status === 404) return NextResponse.json({ error: 'File không còn trên Drive' }, { status: 404 })
      return NextResponse.json({ error: err?.message ?? 'Lỗi Google Drive' }, { status: 502 })
    }
  }
  const abs = localLibraryPath(row.storagePath)
  if (!abs) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat?.isFile()) return NextResponse.json({ error: 'File missing on disk' }, { status: 404 })
  const stream = Readable.toWeb(fs.createReadStream(abs)) as unknown as ReadableStream<Uint8Array>
  return new NextResponse(stream, { headers: headersFor(row, opts.disposition, stat.size) })
}
