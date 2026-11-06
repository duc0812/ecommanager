import { randomInt } from 'crypto'
import { prisma } from '@/lib/db'
import { listConnectedStores } from '@/lib/store-connections'
import { shopifyAdminGraphql, type FetchLike } from '@/lib/clone/shopify-admin'

export const SKU_CODE_RE = /^[A-Z]{2}\d{10}$/

const MAX_ATTEMPTS = 20
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000

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

const VARIANT_WITH_SKU = 'query($q: String!) { productVariants(first: 1, query: $q) { edges { node { id } } } }'

const defaultLog = (message: string) => console.warn(`[clone sku] ${message}`)

// Log lines carry the store id and fixed text or an HTTP status only: an error message or a response body can echo the access token.
const skipNote = (storeId: string, reason: string) => `Bỏ qua kiểm SKU trên Shopify của store ${storeId}: ${reason}`

export function makeShopifySkuExists(opts: { fetchImpl?: FetchLike; log?: (message: string) => void } = {}): SkuCodeDeps['shopifySkuExists'] {
  const log = opts.log ?? defaultLog
  return async (storeId, code) => {
    const answer = await shopifyAdminGraphql(storeId, VARIANT_WITH_SKU, { q: `sku:${code}*` }, { fetchImpl: opts.fetchImpl })
    if ('reason' in answer) {
      log(skipNote(storeId, answer.reason))
      return false
    }
    const edges = (answer.data as { productVariants?: { edges?: unknown[] } }).productVariants?.edges
    return (edges?.length ?? 0) > 0
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
