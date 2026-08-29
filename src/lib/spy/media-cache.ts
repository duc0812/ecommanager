import { prisma } from '@/lib/db'
import fs from 'node:fs'
import path from 'node:path'

// Facebook ad image URLs (fbcdn) carry an expiring signed token, so we download the image
// once (while the URL is still alive) and serve it from disk permanently.
const MEDIA_DIR = path.join(process.cwd(), 'spy-media')

function ensureDir() {
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }) } catch { /* ignore */ }
}

export function cachedFilePath(adId: string) {
  return path.join(MEDIA_DIR, adId.replace(/[^a-zA-Z0-9_-]/g, ''))
}

export function isCached(adId: string) {
  try { return fs.statSync(cachedFilePath(adId)).size > 0 } catch { return false }
}

function sniffContentType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/jpeg'
}

export function readCached(adId: string): { buffer: Buffer; contentType: string } | null {
  try {
    const buffer = fs.readFileSync(cachedFilePath(adId))
    if (!buffer.length) return null
    return { buffer, contentType: sniffContentType(buffer) }
  } catch {
    return null
  }
}

export async function downloadAndCache(adId: string, url: string, timeoutMs = 10000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; EcomManagerBot/1.0)' },
    })
    if (!res.ok) return false
    const ct = res.headers.get('content-type') || ''
    if (!ct.startsWith('image/')) return false
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100) return false
    ensureDir()
    fs.writeFileSync(cachedFilePath(adId), buf)
    return true
  } catch {
    return false
  }
}

// Cache media for recently-seen ads that aren't cached yet (network + count capped).
export async function cachePendingAdMedia(opts: { cap?: number; concurrency?: number } = {}): Promise<{ checked: number; cached: number }> {
  const cap = opts.cap ?? 80
  const concurrency = opts.concurrency ?? 5
  const ads = await prisma.spyAd.findMany({
    where: { mediaUrl: { not: null } },
    select: { id: true, mediaUrl: true },
    orderBy: { lastSeenAt: 'desc' },
    take: 600,
  })
  const todo = ads.filter(a => a.mediaUrl && !isCached(a.id)).slice(0, cap)
  let cached = 0
  let idx = 0
  async function worker() {
    while (idx < todo.length) {
      const a = todo[idx++]
      if (await downloadAndCache(a.id, a.mediaUrl as string)) cached++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()))
  return { checked: todo.length, cached }
}
