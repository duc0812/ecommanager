export type AdLinkKind = 'product' | 'collection' | 'homepage' | 'other'
export type ParsedAdLink = { host: string | null; kind: AdLinkKind | null; handle: string | null }

const NULLS: ParsedAdLink = { host: null, kind: null, handle: null }

export function parseAdLink(linkUrl: string | null): ParsedAdLink {
  if (!linkUrl) return NULLS
  let u: URL
  try {
    u = new URL(linkUrl)
  } catch {
    return NULLS
  }
  if (/^(l|lm)\.facebook\.com$/i.test(u.hostname)) {
    const target = u.searchParams.get('u')
    if (target) {
      try { u = new URL(target) } catch { return NULLS }
    }
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname
  const product = path.match(/\/products\/([^/?#]+)/)
  if (product) return { host, kind: 'product', handle: decodeURIComponent(product[1]) }
  if (/\/collections\//.test(path)) return { host, kind: 'collection', handle: null }
  if (path === '' || path === '/') return { host, kind: 'homepage', handle: null }
  return { host, kind: 'other', handle: null }
}
