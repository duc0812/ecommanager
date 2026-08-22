export function buildAdLibrarySearchUrl(searchTerm: string, country = 'ALL'): string {
  const q = encodeURIComponent(searchTerm)
  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${country}&q=${q}&search_type=keyword_unordered&media_type=all`
}
