export const LITZZY_SHOP = 'caramiaus-store.myshopify.com'

/** Litzzy is the first store, the one whose keys predate stores. Always decided by the shop, never by a missing store id. */
export function isLitzzyStore(store: { shop: string }): boolean {
  return store.shop === LITZZY_SHOP
}

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
