import { prisma } from '@/lib/db'
import fs from 'node:fs'
import path from 'node:path'
import { runExclusive } from '@/lib/job-lock'

// Facebook ad image URLs (fbcdn) carry an expiring signed token, so we download the image
// once (while the URL is still alive) and serve it from disk permanently.
const MEDIA_DIR = process.env.SPY_MEDIA_DIR
  ? path.resolve(process.env.SPY_MEDIA_DIR)
  : path.join(process.cwd(), 'spy-media')
const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_HOST = /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com|cdninstagram\.com)$/i

// URLs that already failed in this process are not retried on every scan; the
// signed token does not come back to life, so the retry would only burn time.
const failedInProcess = new Set<string>()

function ensureDir() {
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }) } catch { /* ignore */ }
}

export function cachedFilePath(adId: string) {
  return path.join(MEDIA_DIR, adId.replace(/[^a-zA-Z0-9_-]/g, ''))
}

export function isCached(adId: string) {
  try { return fs.statSync(cachedFilePath(adId)).size > 0 } catch { return false }
}

function sniffContentType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function readCached(adId: string): { buffer: Buffer; contentType: string } | null {
  try {
    const buffer = fs.readFileSync(cachedFilePath(adId))
    if (!buffer.length) return null
    return { buffer, contentType: sniffContentType(buffer) ?? 'image/jpeg' }
  } catch {
    return null
  }
}

function hostAllowed(url: string) {
  try { return ALLOWED_HOST.test(new URL(url).hostname) } catch { return false }
}

export async function downloadAndCache(adId: string, url: string, timeoutMs = 10000): Promise<boolean> {
  if (!hostAllowed(url) || failedInProcess.has(url)) return false
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; EcomManagerBot/1.0)' },
    })
    if (!res.ok) { failedInProcess.add(url); return false }
    const ct = res.headers.get('content-type') || ''
    if (!ct.startsWith('image/')) { failedInProcess.add(url); return false }
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > MAX_BYTES) { failedInProcess.add(url); return false }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 100 || buf.length > MAX_BYTES || !sniffContentType(buf)) { failedInProcess.add(url); return false }
    ensureDir()
    // Write to a temp file and rename so a crash mid-write never leaves a truncated
    // file that isCached() would then treat as valid forever.
    const target = cachedFilePath(adId)
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, target)
    return true
  } catch {
    failedInProcess.add(url)
    return false
  }
}

async function cacheAds(ads: { id: string; mediaUrl: string | null }[], concurrency: number) {
  const todo = ads.filter(a => a.mediaUrl && !isCached(a.id))
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

// Cache media for a known set of ads (the ones a scan just ingested).
export async function cacheAdMediaForIds(ids: string[], opts: { concurrency?: number } = {}) {
  if (ids.length === 0) return { checked: 0, cached: 0 }
  const ads = await prisma.spyAd.findMany({
    where: { id: { in: ids }, mediaUrl: { not: null } },
    select: { id: true, mediaUrl: true },
  })
  return cacheAds(ads, opts.concurrency ?? 4)
}

// Cache media for recently-seen ads that aren't cached yet (network + count capped).
// Guarded so overlapping scans share one sweep instead of downloading the same files N times.
export async function cachePendingAdMedia(opts: { cap?: number; concurrency?: number } = {}): Promise<{ checked: number; cached: number }> {
  const cap = opts.cap ?? 200
  const outcome = await runExclusive('spy:media-cache', async () => {
    const ads = await prisma.spyAd.findMany({
      where: { mediaUrl: { not: null } },
      select: { id: true, mediaUrl: true },
      orderBy: { lastSeenAt: 'desc' },
      take: 600,
    })
    return cacheAds(ads.filter(a => !isCached(a.id)).slice(0, cap), opts.concurrency ?? 4)
  })
  return outcome.skipped ? { checked: 0, cached: 0 } : outcome.result
}
