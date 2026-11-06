import { assertSafeExternalUrl } from '@/lib/safe-url'
import { getStoreConnection, type StoreConnection } from '@/lib/store-connections'

export const SHOPIFY_API_VERSION = '2024-10'
export const SHOPIFY_TIMEOUT_MS = 15_000

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type AdminGraphqlResult = { data: unknown } | { reason: string }

// One Admin GraphQL call to a connected store. The token only ever goes into the request header, and `reason` is fixed text or
// `HTTP <status>`: an error message or a response body can echo the access token, so neither is ever passed on.
export async function shopifyAdminGraphql(
  storeId: string,
  query: string,
  variables: Record<string, unknown>,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<AdminGraphqlResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  let conn: StoreConnection
  try {
    conn = await getStoreConnection(storeId)
  } catch {
    return { reason: 'không lấy được kết nối của store' }
  }
  let url: URL
  try {
    url = assertSafeExternalUrl(`https://${conn.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`)
  } catch {
    return { reason: 'địa chỉ shop không hợp lệ' }
  }
  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': conn.token },
      body: JSON.stringify({ query, variables }),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? SHOPIFY_TIMEOUT_MS),
    })
  } catch {
    return { reason: 'không kết nối được tới Shopify' }
  }
  if (!res.ok) return { reason: `HTTP ${res.status}` }
  const json = await res.json().catch(() => null) as { data?: unknown; errors?: unknown } | null
  if (!json || json.errors || json.data === undefined || json.data === null) return { reason: 'Shopify trả về dữ liệu không đọc được' }
  return { data: json.data }
}
