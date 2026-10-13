import { ensurePublicToken, publicArtworkUrl, requirePublicBaseUrl } from '@/lib/public-artwork'

export const APP_FILE_PREFIX = '/api/design-studio/file/'
export const DESIGN_LINK_SEPARATOR = ' | '

export type LinkArtwork = {
  id: string; printArea: string; version: number; fileName: string; mimeType: string; storage: string; driveWebViewLink: string | null
}
export type SlotLink = { area: string; url: string; artworkId: string; local: boolean }

export function isAppFileLink(link: string | null | undefined): link is string {
  return !!link && link.startsWith(APP_FILE_PREFIX)
}

export function appFileArtworkId(link: string): string | null {
  if (!isAppFileLink(link)) return null
  const id = link.slice(APP_FILE_PREFIX.length).split(/[/?#]/)[0]
  return id || null
}

/** A link Design Studio wrote: the task's Drive folder, the app file URL of a local artwork, or the Drive link of one of the line's artworks. */
export function isStudioLink(link: string | null | undefined, artworks: Array<{ driveWebViewLink: string | null }>, folderUrl?: string | null): boolean {
  if (!link) return false
  return isAppFileLink(link) || (!!folderUrl && link === folderUrl) || artworks.some(a => a.driveWebViewLink === link)
}

/** Reads NEXT_PUBLIC_APP_URL only when a local file needs a public link, and only once. Throws PublicUrlError. */
export function lazyPublicBase(): () => string {
  let base: string | undefined
  return () => (base ??= requirePublicBaseUrl())
}

/** A link somebody outside the app can open: the Drive link, or the public artwork URL for a file the app still holds. */
export async function factoryLinkFor(a: LinkArtwork, publicBase: () => string): Promise<{ url: string; local: boolean }> {
  if (a.storage === 'DRIVE' && a.driveWebViewLink) return { url: a.driveWebViewLink, local: false }
  const base = publicBase()
  return { url: publicArtworkUrl(base, await ensurePublicToken(a.id), a), local: true }
}

export function joinDesignLinks(links: Array<{ url: string }>): string {
  return Array.from(new Set(links.map(l => l.url))).join(DESIGN_LINK_SEPARATOR)
}
