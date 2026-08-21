export function normalizeFbPageUrl(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null
    const path = u.pathname.replace(/\/$/, '')
    return `${u.protocol}//${u.host}${path}${u.search}`
  } catch {
    return null
  }
}
