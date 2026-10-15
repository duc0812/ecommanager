import { DESIGN_LINK_SEPARATOR } from '@/lib/design-links'
import { assertSafeExternalUrl } from '@/lib/safe-url'

export type PublicDriveFile = { id: string; name: string; folder: boolean; viewUrl: string }
export type PublicDriveLink = { url: string; kind: 'file' | 'folder'; files: PublicDriveFile[]; error: string | null }

const ID = /^[A-Za-z0-9_-]{10,}$/
const MAX_LINKS = 4
const MAX_FILES = 12
const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 500

declare global {
  // eslint-disable-next-line no-var
  var __publicDriveCache: Map<string, { at: number; value: PublicDriveLink }> | undefined
}

function cache() {
  if (!global.__publicDriveCache) global.__publicDriveCache = new Map()
  return global.__publicDriveCache
}

/** A Drive file or folder id from the link shapes people paste: `/file/d/<id>`, `/drive/folders/<id>`, `open?id=<id>`, `uc?id=<id>`. */
export function parseDriveLink(raw: string): { kind: 'file' | 'folder'; id: string } | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname)) return null
  const folder = /\/folders\/([^/?#]+)/.exec(url.pathname)?.[1]
  if (folder && ID.test(folder)) return { kind: 'folder', id: folder }
  const file = /\/d\/([^/?#]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id')
  if (file && ID.test(file)) return { kind: 'file', id: file }
  return null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** The entries of Drive's public folder page (`embeddedfolderview`): one `flip-entry` per file or sub-folder. */
export function parseFolderEmbed(html: string): PublicDriveFile[] {
  const out: PublicDriveFile[] = []
  for (const chunk of html.split('<div class="flip-entry"').slice(1)) {
    const id = /id="entry-([A-Za-z0-9_-]+)"/.exec(chunk)?.[1]
    const title = /class="flip-entry-title">([^<]*)</.exec(chunk)?.[1]
    if (!id || title === undefined) continue
    const folder = /href="https:\/\/drive\.google\.com\/drive\/folders\//.test(chunk)
    out.push({ id, name: decodeEntities(title).trim(), folder, viewUrl: folder ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view` })
  }
  return out
}

async function readFolder(id: string): Promise<PublicDriveFile[]> {
  const url = assertSafeExternalUrl(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`, { allowedHosts: ['drive.google.com'] })
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual', headers: { 'Accept-Language': 'en' } })
  // A private folder answers with a redirect to the Google sign-in page.
  if (res.status >= 300 && res.status < 400) throw new Error('Thư mục không công khai')
  if (!res.ok) throw new Error(`Drive trả ${res.status}`)
  return parseFolderEmbed(await res.text())
}

async function describe(raw: string): Promise<PublicDriveLink | null> {
  const parsed = parseDriveLink(raw)
  if (!parsed) return null
  const url = raw.trim()
  if (parsed.kind === 'file') {
    return { url, kind: 'file', files: [{ id: parsed.id, name: '', folder: false, viewUrl: `https://drive.google.com/file/d/${parsed.id}/view` }], error: null }
  }
  const hit = cache().get(parsed.id)
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, url }
  let value: PublicDriveLink
  try {
    const files = await readFolder(parsed.id)
    value = { url, kind: 'folder', files: files.slice(0, MAX_FILES), error: files.length === 0 ? 'Thư mục trống' : null }
  } catch (err: any) {
    value = { url, kind: 'folder', files: [], error: err?.message ?? 'Không đọc được thư mục' }
  }
  const c = cache()
  if (c.size >= CACHE_MAX) c.delete(c.keys().next().value as string)
  c.set(parsed.id, { at: Date.now(), value })
  return value
}

/**
 * What a design link written outside the studio (Trello era) holds, for a preview: each Drive file, or the files of each shared
 * Drive folder as listed by Drive's public folder page. Other links are left out; the caller still shows them as links.
 */
export async function describeDesignLinks(stored: string): Promise<PublicDriveLink[]> {
  const parts = stored.split(DESIGN_LINK_SEPARATOR).map(p => p.trim()).filter(Boolean).slice(0, MAX_LINKS)
  const out = await Promise.all(parts.map(describe))
  return out.filter((l): l is PublicDriveLink => l !== null)
}

export function resetPublicDriveCache() {
  cache().clear()
}
