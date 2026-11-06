import { randomInt } from 'crypto'
import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { getStoreConnection, listConnectedStores } from '@/lib/store-connections'

export const SKU_CODE_RE = /^[A-Z]{2}\d{10}$/

const MAX_ATTEMPTS = 20
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000
const SHOPIFY_API_VERSION = '2024-10'
const SHOPIFY_TIMEOUT_MS = 10_000

const FORMAT_MESSAGE = 'Mã SKU phải là 2 chữ cái A–Z.'
const TAKEN_MESSAGE = 'Mã SKU này đã thuộc tài khoản khác.'

export type SkuCodeDeps = {
  random: () => number
  shopifySkuExists: (storeId: string, code: string) => Promise<boolean>
  storeIds: () => Promise<string[]>
  log?: (message: string) => void
}

export function parseSkuPrefix(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : null
}

// The raw `skuPrefix` of a users API body: undefined = leave it, '' = clear it, anything else must be two letters nobody else holds.
export type SkuPrefixChange = { change: false } | { change: true; value: string | null } | { error: string; status: 400 | 409 }

export async function resolveSkuPrefixChange(raw: unknown, userId?: string): Promise<SkuPrefixChange> {
  if (raw === undefined) return { change: false }
  if (raw === '') return { change: true, value: null }
  const value = parseSkuPrefix(raw)
  if (!value) return { error: FORMAT_MESSAGE, status: 400 }
  const holder = await prisma.appUser.findUnique({ where: { skuPrefix: value }, select: { id: true } })
  if (holder && holder.id !== userId) return { error: TAKEN_MESSAGE, status: 409 }
  return { change: true, value }
}

// The date is the calendar date in Asia/Ho_Chi_Minh (UTC+7, no DST).
export function skuCodeFor(prefix: string, now: Date, n: number): string {
  const d = new Date(now.getTime() + VIETNAM_OFFSET_MS)
  const two = (x: number) => String(x).padStart(2, '0')
  return `${prefix}${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${String(n).padStart(4, '0')}`
}

export function skuBelongsTo(code: string, sku: string | null): boolean {
  return sku !== null && (sku === code || sku.startsWith(`${code}-`))
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const VARIANT_WITH_SKU = 'query($q: String!) { productVariants(first: 1, query: $q) { edges { node { id } } } }'

const defaultLog = (message: string) => console.warn(`[clone sku] ${message}`)

// Log lines carry the store id and fixed text or an HTTP status only: an error message or a response body can echo the access token.
const skipNote = (storeId: string, reason: string) => `Bỏ qua kiểm SKU trên Shopify của store ${storeId}: ${reason}`

export function makeShopifySkuExists(opts: { fetchImpl?: FetchLike; log?: (message: string) => void } = {}): SkuCodeDeps['shopifySkuExists'] {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const log = opts.log ?? defaultLog
  return async (storeId, code) => {
    const skip = (reason: string) => {
      log(skipNote(storeId, reason))
      return false
    }
    let conn: { shop: string; token: string }
    try {
      conn = await getStoreConnection(storeId)
    } catch {
      return skip('không lấy được kết nối của store')
    }
    let url: URL
    try {
      url = assertSafeExternalUrl(`https://${conn.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`)
    } catch {
      return skip('địa chỉ shop không hợp lệ')
    }
    let res: Response
    try {
      res = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': conn.token },
        body: JSON.stringify({ query: VARIANT_WITH_SKU, variables: { q: `sku:${code}*` } }),
        redirect: 'error',
        signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
      })
    } catch {
      return skip('không kết nối được tới Shopify')
    }
    if (!res.ok) return skip(`Shopify trả về HTTP ${res.status}`)
    const json = await res.json().catch(() => null) as { data?: { productVariants?: { edges?: unknown[] } }; errors?: unknown } | null
    if (!json || json.errors) return skip('Shopify trả về dữ liệu không đọc được')
    return (json.data?.productVariants?.edges?.length ?? 0) > 0
  }
}

function withDefaults(deps: Partial<SkuCodeDeps>): SkuCodeDeps {
  const log = deps.log ?? defaultLog
  return {
    random: () => randomInt(0, 10000),
    shopifySkuExists: makeShopifySkuExists({ log }),
    storeIds: async () => (await listConnectedStores()).map(s => s.id),
    ...deps,
    log,
  }
}

export async function isCodeTaken(code: string, deps: SkuCodeDeps): Promise<boolean> {
  const hit = async (found: Promise<unknown>) => (await found) !== null
  if (await hit(prisma.cloneJob.findUnique({ where: { skuCode: code }, select: { id: true } }))) return true
  if (await hit(prisma.orderLine.findFirst({ where: { sku: { startsWith: code } }, select: { id: true } }))) return true
  if (await hit(prisma.skuSupplierDesign.findFirst({ where: { sku: { startsWith: code } }, select: { id: true } }))) return true
  if (await hit(prisma.skuDesign.findFirst({ where: { sku: { startsWith: code } }, select: { id: true } }))) return true
  if (await hit(prisma.artworkEntry.findFirst({ where: { title: { contains: code } }, select: { id: true } }))) return true
  if (await hit(prisma.productProfile.findFirst({ where: { title: { contains: code } }, select: { id: true } }))) return true
  for (const storeId of await deps.storeIds()) {
    try {
      if (await deps.shopifySkuExists(storeId, code)) return true
    } catch {
      (deps.log ?? defaultLog)(skipNote(storeId, 'không hỏi được Shopify'))
    }
  }
  return false
}

export async function issueSkuCode(prefix: string, now: Date, deps: Partial<SkuCodeDeps> = {}): Promise<string> {
  const full = withDefaults(deps)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = skuCodeFor(prefix, now, full.random())
    if (!(await isCodeTaken(code, full))) return code
  }
  throw new Error('Không cấp được mã SKU, thử lại sau.')
}
