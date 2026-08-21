export type ParsedSpyAd = {
  adArchiveId: string; pageId: string; pageName: string | null; pageCategory: string | null
  pageLikes: number | null; igUsername: string | null; igFollowers: number | null
  isActive: boolean; startDate: Date | null; endDate: Date | null
  collationCount: number | null; collationId: string | null
  mediaType: 'video' | 'image' | 'carousel' | 'dco' | null; displayFormat: string | null
  ctaType: string | null; ctaText: string | null; linkUrl: string | null
  title: string | null; body: string | null; caption: string | null
  publisherPlatforms: string[]; currency: string | null; adLibraryUrl: string | null; rawPayload: any
}

function unixToDate(v: any): Date | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null
}

function bodyToString(body: any): string | null {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (typeof body === 'object' && typeof body.text === 'string') return body.text
  return null
}

function detectMediaType(snapshot: any): ParsedSpyAd['mediaType'] {
  if (!snapshot) return null
  if (Array.isArray(snapshot.cards) && snapshot.cards.length > 1) return 'carousel'
  if (Array.isArray(snapshot.videos) && snapshot.videos.length > 0) return 'video'
  if (Array.isArray(snapshot.images) && snapshot.images.length > 0) return 'image'
  const df = String(snapshot.display_format ?? '').toLowerCase()
  if (df === 'dco' || df === 'dpa') return 'dco'
  return null
}

export function mapApifyAd(raw: any): ParsedSpyAd {
  const snapshot = raw?.snapshot ?? {}
  const pageInfo = raw?.advertiser?.ad_library_page_info?.page_info ?? {}
  const num = (v: any) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null)
  return {
    adArchiveId: String(raw?.ad_archive_id ?? raw?.adArchiveId ?? ''),
    pageId: String(raw?.page_id ?? snapshot.page_id ?? ''),
    pageName: raw?.page_name ?? snapshot.page_name ?? null,
    pageCategory: pageInfo.page_category ?? null,
    pageLikes: num(pageInfo.likes),
    igUsername: pageInfo.ig_username ?? null,
    igFollowers: num(pageInfo.ig_followers),
    isActive: Boolean(raw?.is_active),
    startDate: unixToDate(raw?.start_date),
    endDate: unixToDate(raw?.end_date),
    collationCount: num(raw?.collation_count),
    collationId: raw?.collation_id ?? null,
    mediaType: detectMediaType(snapshot),
    displayFormat: snapshot.display_format ?? null,
    ctaType: snapshot.cta_type ?? null,
    ctaText: snapshot.cta_text ?? null,
    linkUrl: snapshot.link_url ?? null,
    title: snapshot.title ?? null,
    body: bodyToString(snapshot.body),
    caption: snapshot.caption ?? null,
    publisherPlatforms: Array.isArray(raw?.publisher_platform) ? raw.publisher_platform : [],
    currency: raw?.currency ?? null,
    adLibraryUrl: raw?.ad_library_url ?? null,
    rawPayload: raw,
  }
}
