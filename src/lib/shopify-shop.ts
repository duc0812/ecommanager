const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop.trim().toLowerCase())
}

export function normalizeShopDomain(shop: string): string | null {
  const cleaned = shop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return isValidShopDomain(cleaned) ? cleaned : null
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
