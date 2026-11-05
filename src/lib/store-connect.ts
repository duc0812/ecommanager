import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'

const API_VERSION = '2024-10'
const SNAPSHOT_TIMEOUT_MS = 15_000

export type ShopSnapshot = {
  shopName: string
  timezone: string | null
  scopes: string[]
  latestOrderName: string | null
}

// Messages are fixed text: a Shopify error body can echo the token that was sent, so none of it is relayed.
export class ShopSnapshotError extends Error {
  kind: 'TOKEN_REJECTED' | 'MISSING_ORDERS_SCOPE' | 'UNREACHABLE'

  constructor(kind: ShopSnapshotError['kind'], message: string) {
    super(message)
    this.name = 'ShopSnapshotError'
    this.kind = kind
  }
}

const SNAPSHOT_QUERY = `
query ConnectCheck {
  shop { name ianaTimezone }
  currentAppInstallation { accessScopes { handle } }
  orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { name } }
}`

// One call that proves the token works and reads what the form needs: the shop name and timezone,
// the scopes the app was granted and the newest order (its name carries the store's order prefix).
export async function readShopSnapshot(shop: string, token: string): Promise<ShopSnapshot> {
  let url: URL
  try {
    url = assertSafeExternalUrl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`)
  } catch {
    throw new ShopSnapshotError('UNREACHABLE', 'Địa chỉ shop không hợp lệ')
  }
  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: SNAPSHOT_QUERY }),
      redirect: 'error',
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    })
  } catch {
    throw new ShopSnapshotError('UNREACHABLE', 'Không kết nối được tới Shopify')
  }
  if (res.status === 401 || res.status === 403) throw new ShopSnapshotError('TOKEN_REJECTED', 'Shopify từ chối access token này')
  if (!res.ok) throw new ShopSnapshotError('UNREACHABLE', `Shopify trả về lỗi HTTP ${res.status}`)
  const json = await res.json().catch(() => null) as {
    data?: {
      shop?: { name?: unknown; ianaTimezone?: unknown } | null
      currentAppInstallation?: { accessScopes?: Array<{ handle?: unknown }> | null } | null
      orders?: { nodes?: Array<{ name?: unknown }> | null } | null
    } | null
    errors?: Array<{ path?: unknown[] }>
  } | null
  const errors = Array.isArray(json?.errors) ? json.errors : []
  if (errors.some(e => e?.path?.[0] === 'orders')) {
    throw new ShopSnapshotError('MISSING_ORDERS_SCOPE', 'Token này không có quyền đọc đơn (read_orders). Thêm quyền read_orders cho app rồi kết nối lại.')
  }
  const data = json?.data
  if (errors.length > 0 || !data?.shop) throw new ShopSnapshotError('UNREACHABLE', 'Shopify trả về dữ liệu không đọc được')
  const handles = data.currentAppInstallation?.accessScopes ?? []
  const latest = data.orders?.nodes?.[0]?.name
  return {
    shopName: typeof data.shop.name === 'string' && data.shop.name ? data.shop.name : shop,
    timezone: typeof data.shop.ianaTimezone === 'string' && data.shop.ianaTimezone ? data.shop.ianaTimezone : null,
    scopes: handles.map(h => h?.handle).filter((h): h is string => typeof h === 'string'),
    latestOrderName: typeof latest === 'string' && latest ? latest : null,
  }
}

// "#LIT9" and "#LIT-9" are LIT; "#1001" has no prefix.
export function orderPrefixFromName(name: string | null | undefined): string | null {
  const letters = name?.trim().match(/^#?([A-Za-z]+)/)?.[1]
  return letters ? letters.toUpperCase() : null
}

export const hasReadAllOrders = (scopes: string[]) => scopes.includes('read_all_orders')

// The dates a store keeps are plain YYYY-MM-DD strings (ShopifyStore.payoutStartDate); a date that rolls over, like 2026-02-30, is not one.
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

export function isoDateToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

// The page customers' tracking links point at. It is stored as typed, but it must be a public https address.
export function checkTrackingPageUrl(value: string): string | null {
  try {
    assertSafeExternalUrl(value)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'URL không hợp lệ'
  }
}

const scopesKey = (storeId: string) => `store.scopes.${storeId}`

// Which scopes a store's app was granted when it was last checked; the Setup card shows it. Not a secret.
export async function saveGrantedScopes(storeId: string, scopes: string[], db: Pick<typeof prisma, 'appSetting'> = prisma): Promise<void> {
  const value = JSON.stringify({ scopes, checkedAt: new Date().toISOString() })
  await db.appSetting.upsert({ where: { key: scopesKey(storeId) }, create: { key: scopesKey(storeId), value }, update: { value } })
}

export async function loadGrantedScopes(storeIds: string[]): Promise<Map<string, string[]>> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: storeIds.map(scopesKey) } } })
  const byStore = new Map<string, string[]>()
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as { scopes?: unknown }
      if (Array.isArray(parsed.scopes)) byStore.set(row.key.slice('store.scopes.'.length), parsed.scopes.filter((s): s is string => typeof s === 'string'))
    } catch {}
  }
  return byStore
}
