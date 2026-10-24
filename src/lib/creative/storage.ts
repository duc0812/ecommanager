import fs from 'fs/promises'
import path from 'path'
import { storageRoot } from '@/lib/design-storage'
import { assertSafeExternalUrl } from '@/lib/safe-url'

export const MAX_REF_IMAGES = 4
export const MAX_REF_BYTES = 10 * 1024 * 1024
export const REF_TYPES_LABEL = 'PNG, JPG, WEBP'

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const FILE_NAME = /^(ref|out)-\d+\.(png|jpe?g|webp)$/
const JOB_ID = /^[a-z0-9]+$/i

export function creativeRoot(): string {
  return path.join(storageRoot(), 'creative')
}

export function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl ?? '')
  if (!m) return null
  return { mime: m[1].toLowerCase(), bytes: Buffer.from(m[2].replace(/\s/g, ''), 'base64') }
}

export function extForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null
}

export async function saveRef(jobId: string, index: number, parsed: { mime: string; bytes: Buffer }): Promise<{ name: string; mime: string; bytes: Buffer }> {
  const ext = extForMime(parsed.mime)
  if (!ext) throw new Error('unsupported mime')
  const name = `ref-${index}.${ext}`
  const dir = path.join(creativeRoot(), jobId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), parsed.bytes)
  return { name, mime: parsed.mime, bytes: parsed.bytes }
}

export async function saveResult(jobId: string, index: number, url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const safe = assertSafeExternalUrl(url)
  const res = await fetchImpl(safe.toString())
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`)
  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = extForMime(mime) ?? (/\.(jpe?g|webp)(\?|$)/i.exec(safe.pathname)?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? 'png')
  const name = `out-${index}.${ext}`
  const dir = path.join(creativeRoot(), jobId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), Buffer.from(await res.arrayBuffer()))
  return name
}

export function resolveFile(jobId: string, name: string): string | null {
  if (!JOB_ID.test(jobId) || !FILE_NAME.test(name)) return null
  const root = path.resolve(creativeRoot())
  const abs = path.resolve(root, jobId, name)
  if (!abs.startsWith(root + path.sep)) return null
  return abs
}

export async function deleteJobFolder(jobId: string) {
  if (!JOB_ID.test(jobId)) return
  await fs.rm(path.join(creativeRoot(), jobId), { recursive: true, force: true })
}
