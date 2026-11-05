import { prisma } from '@/lib/db'
import { runExclusive } from '@/lib/job-lock'
import { getStoreConnection, listConnectedStores, type ConnectedStore, type StoreConnection } from '@/lib/store-connections'

export type StoreRunResult<T> =
  | { storeId: string; shop: string; ok: true; result: T }
  | { storeId: string; shop: string; ok: false; error: string; skipped?: boolean }

const MAX_ERROR_LENGTH = 500
const SECRET_PATTERNS = [
  /shp(?:at|ca|ss|pa)_[A-Za-z0-9]+/g,
  /((?:access_token|client_secret|client_id|token|secret)=)[^&\s"']+/gi,
  /((?:access_token|client_secret|token|secret)["']?\s*[:=]\s*["'])[^"']+/gi,
]

// What gets stored in ShopifyStore.lastError and shown to users: never a token or a secret.
export function safeErrorText(error: unknown, secrets: string[] = []): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  for (const secret of secrets) if (secret.length >= 6) text = text.split(secret).join('***')
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (_m, prefix) => `${typeof prefix === 'string' ? prefix : ''}***`)
  text = text.trim()
  if (!text) return 'Lỗi không rõ'
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text
}

// lastError is one field shared by every job of the store, so it says which job failed ("[order-sync] ...")
// and only that job succeeding clears it; another job's success must not hide a failure it did not fix.
const errorTag = (job: string) => `[${job}] `

async function recordStoreError(storeId: string, job: string, error: string | null) {
  try {
    if (error === null) {
      await prisma.shopifyStore.updateMany({
        where: { id: storeId, lastError: { startsWith: errorTag(job) } },
        data: { lastError: null, lastErrorAt: null },
      })
    } else {
      await prisma.shopifyStore.update({ where: { id: storeId }, data: { lastError: `${errorTag(job)}${error}`, lastErrorAt: new Date() } })
    }
  } catch (e) {
    console.error(`[store-jobs] could not record the result for store ${storeId}:`, e instanceof Error ? e.message : e)
  }
}

/** Thrown by a job for a store it deliberately does not run (it has nothing to run with). The store is reported as skipped and its last error is left alone. */
export class StoreJobSkipped extends Error {}

async function runForStore<T>(
  job: string,
  store: ConnectedStore,
  fn: (conn: StoreConnection, store: ConnectedStore) => Promise<T>,
): Promise<StoreRunResult<T>> {
  const secrets: string[] = []
  try {
    const outcome = await runExclusive(`${job}:${store.id}`, async () => {
      const conn = await getStoreConnection(store.id)
      secrets.push(conn.token)
      return fn(conn, store)
    })
    if (outcome.skipped) {
      return { storeId: store.id, shop: store.shop, ok: false, skipped: true, error: `${job} đang chạy cho ${store.shop}, bỏ qua lần này` }
    }
    await recordStoreError(store.id, job, null)
    return { storeId: store.id, shop: store.shop, ok: true, result: outcome.result }
  } catch (e) {
    if (e instanceof StoreJobSkipped) return { storeId: store.id, shop: store.shop, ok: false, skipped: true, error: e.message }
    const error = safeErrorText(e, secrets)
    await recordStoreError(store.id, job, error)
    return { storeId: store.id, shop: store.shop, ok: false, error }
  }
}

// One store at a time, oldest connection first. A store that cannot connect or whose job throws is
// recorded on that store and the next one still runs; the same job never overlaps itself on one store.
export async function forEachConnectedStore<T>(
  job: string,
  fn: (conn: StoreConnection, store: ConnectedStore) => Promise<T>,
  opts: { storeIds?: string[] } = {},
): Promise<StoreRunResult<T>[]> {
  let stores = await listConnectedStores()
  if (opts.storeIds) {
    const wanted = new Set(opts.storeIds)
    stores = stores.filter(s => wanted.has(s.id))
  }
  const results: StoreRunResult<T>[] = []
  for (const store of stores) results.push(await runForStore(job, store, fn))
  return results
}

export function okResults<T>(results: StoreRunResult<T>[]): Array<Extract<StoreRunResult<T>, { ok: true }>> {
  return results.filter((r): r is Extract<StoreRunResult<T>, { ok: true }> => r.ok)
}

export function failedResults<T>(results: StoreRunResult<T>[]): Array<Extract<StoreRunResult<T>, { ok: false }>> {
  return results.filter((r): r is Extract<StoreRunResult<T>, { ok: false }> => !r.ok)
}

export function logStoreFailures<T>(tag: string, results: StoreRunResult<T>[]) {
  for (const r of failedResults(results)) console.error(`[${tag}] ${r.shop}: ${r.error}`)
}

type MergeKeys<T> = { sum?: Array<keyof T>; concat?: Array<keyof T> }

// How each store went, without the result payload (which can be large and is already in the totals).
export function storeRunSummary<T>(results: StoreRunResult<T>[]) {
  return results.map(r => (r.ok
    ? { storeId: r.storeId, shop: r.shop, ok: true as const }
    : { storeId: r.storeId, shop: r.shop, ok: false as const, error: r.error, ...(r.skipped ? { skipped: true as const } : {}) }))
}

// Saves a scheduler's last result under its AppSetting key. The fields a single store always had are
// the totals over the stores that succeeded; `stores` says how each store went. Nothing is saved when
// no store succeeded, which is what a failed run always did.
export async function saveJobResult<T extends object>(key: string, results: StoreRunResult<T>[], keys: MergeKeys<T>): Promise<T | null> {
  return saveMergedJobResult(key, mergeStoreResults(results, keys), results)
}

// Same, for a caller that adjusted the merged totals itself.
export async function saveMergedJobResult<T extends object>(key: string, merged: T | null, results: StoreRunResult<T>[]): Promise<T | null> {
  if (!merged) return null
  const value = JSON.stringify({ ...merged, shop: okResults(results)[0].shop, stores: storeRunSummary(results), ranAt: new Date().toISOString() })
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return merged
}

// One result in the shape a single store always had: the first successful run, with the counters
// summed and the lists joined across every successful store. With one store this is that store's result.
export function mergeStoreResults<T extends object>(results: StoreRunResult<T>[], keys: MergeKeys<T>): T | null {
  const ok = okResults(results)
  if (ok.length === 0) return null
  const merged: any = { ...ok[0].result }
  for (const key of keys.sum ?? []) merged[key] = ok.reduce((total, r) => total + (Number((r.result as any)[key]) || 0), 0)
  for (const key of keys.concat ?? []) merged[key] = ok.flatMap(r => (Array.isArray((r.result as any)[key]) ? (r.result as any)[key] : []))
  return merged as T
}
