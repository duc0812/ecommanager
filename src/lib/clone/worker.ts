import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { hashedTokenInfo, mintHashedToken, revokeHashedToken, verifyBearerHash } from '@/lib/hashed-token'
import { listConnectedStores } from '@/lib/store-connections'
import { waitForCloneQueue } from '@/lib/clone/jobs'
import { getCloneSettings } from '@/lib/clone/settings'
import { skuBelongsTo } from '@/lib/clone/sku-code'
import { shopifyAdminGraphql, type FetchLike } from '@/lib/clone/shopify-admin'

export const CLONE_WORKER_TOKEN_KEY = 'clone.worker.tokenHash'
export const CLONE_WORKER_SEEN_KEY = 'clone.worker.lastSeenAt'
export const CLONE_LEASE_MS = 10 * 60 * 1000
export const CLONE_MAX_ATTEMPTS = 2
export const CLONE_MAX_WAIT_S = 25

const ONLINE_MS = 90_000
const CLAIM_ROUNDS = 20
const MAX_ERROR = 2000
const MAX_QA_NOTE = 500
const MAX_INT = 2_147_483_647
const MAX_VARIANT_PAGES = 12

// Fixed server texts. VERIFY and WORKER_LOST errors are shown to sellers, so nothing from the runner is ever joined into them.
const STORE_GONE = 'Store không còn kết nối.'
const WORKER_LOST = 'Máy xử lý không trả kết quả.'
const QA_FAILED = 'QA không đạt.'
const BAD_PRODUCT_GID = 'Kết quả không có productGid hợp lệ.'
const ASK_AGAIN = 'Chưa hỏi được Shopify, gửi lại kết quả sau.'
const MISSING = 'Sản phẩm không có trên store.'
const NOT_ACTIVE = 'Sản phẩm chưa ACTIVE.'
const NOT_ONLINE = 'Sản phẩm chưa lên Online Store.'
const FOREIGN_SKU = 'Còn variant mang SKU khác mã đã cấp.'

const STAGES = ['nhận diện', 'clone', 'qa', 'public']
const PLATFORM_RE = /^(customily|customall|teeinblue|customix|unknown|unsupported:[a-z0-9-]{1,20})$/
const RUNNER_FAIL_KINDS = ['UNSUPPORTED', 'NOT_ENABLED', 'SOURCE', 'TOOL', 'TOOL_GAP', 'QA', 'TIMEOUT']
const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/

export function generateCloneWorkerToken(): Promise<string> {
  return mintHashedToken('cqw_', CLONE_WORKER_TOKEN_KEY)
}

export function revokeCloneWorkerToken(): Promise<void> {
  return revokeHashedToken(CLONE_WORKER_TOKEN_KEY)
}

export async function cloneWorkerInfo(): Promise<{ configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }> {
  const [token, seen] = await Promise.all([
    hashedTokenInfo(CLONE_WORKER_TOKEN_KEY),
    prisma.appSetting.findUnique({ where: { key: CLONE_WORKER_SEEN_KEY } }),
  ])
  const seenMs = seen ? Date.parse(seen.value) : NaN
  const lastSeenAt = Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : null
  return {
    configured: token.configured,
    tokenUpdatedAt: token.configured ? token.updatedAt : null,
    lastSeenAt,
    online: lastSeenAt !== null && Date.now() - seenMs <= ONLINE_MS,
  }
}

export function verifyCloneWorkerRequest(req: NextRequest): Promise<boolean> {
  return verifyBearerHash(req.headers.get('authorization'), CLONE_WORKER_TOKEN_KEY)
}

// Every runner call counts as a sign of life: while a job runs the runner only heartbeats (every 60 s), and the page calls it
// offline after 90 s. Only reached after the route has verified the bearer token.
async function markWorkerSeen(now: Date = new Date()): Promise<void> {
  const value = now.toISOString()
  await prisma.appSetting.upsert({ where: { key: CLONE_WORKER_SEEN_KEY }, create: { key: CLONE_WORKER_SEEN_KEY, value }, update: { value } })
}

export type CloneClaim = {
  id: string
  sourceUrl: string
  skuCode: string
  attempts: number
  requestedByName: string
  store: { id: string; orderPrefix: string; shop: string }
  targets: string[]
  force: boolean
}

type ClaimResult = { job: CloneClaim | null; paused: boolean }

// The lease condition is the compare-and-set: a heartbeat that lands first moves lockedAt out of it, and the row is left alone.
async function releaseExpiredLeases(now: Date, staleBefore: Date): Promise<void> {
  const expired = { status: 'RUNNING', OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }] }
  await prisma.cloneJob.updateMany({
    where: { ...expired, attempts: { lt: CLONE_MAX_ATTEMPTS } },
    data: { status: 'QUEUED', lockedAt: null, stage: null },
  })
  await prisma.cloneJob.updateMany({
    where: { ...expired, attempts: { gte: CLONE_MAX_ATTEMPTS } },
    data: { status: 'FAILED', failKind: 'WORKER_LOST', error: WORKER_LOST, finishedAt: now, lockedAt: null },
  })
}

export async function claimCloneJob(now: Date = new Date()): Promise<ClaimResult> {
  await markWorkerSeen(now)
  const settings = await getCloneSettings()
  if (settings.paused) return { job: null, paused: true }
  const stores = new Map((await listConnectedStores()).map(s => [s.id, s]))
  const staleBefore = new Date(now.getTime() - CLONE_LEASE_MS)
  const idle: ClaimResult = { job: null, paused: false }
  for (let round = 0; round < CLAIM_ROUNDS; round++) {
    await releaseExpiredLeases(now, staleBefore)
    // After the release every RUNNING row is inside its lease. One read answers both "is a job still running" and "which job is next":
    // two claims at once see the same oldest job, one write wins, and the loser reads again and finds it running. Any lost write starts the round over.
    const rows = await prisma.cloneJob.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, storeId: true, status: true, attempts: true, startedAt: true, sourceUrl: true, skuCode: true, requestedByName: true, force: true },
    })
    if (rows.some(r => r.status === 'RUNNING')) return idle
    const next = rows[0]
    if (!next) return idle
    const unchanged = { id: next.id, status: 'QUEUED', attempts: next.attempts }
    const store = stores.get(next.storeId)
    if (!store?.orderPrefix) {
      await prisma.cloneJob.updateMany({ where: unchanged, data: { status: 'FAILED', failKind: 'TOOL', error: STORE_GONE, finishedAt: now, lockedAt: null } })
      continue
    }
    const attempts = next.attempts + 1
    const won = await prisma.cloneJob.updateMany({
      where: unchanged,
      data: { status: 'RUNNING', attempts, lockedAt: now, stage: null, ...(next.startedAt ? {} : { startedAt: now }) },
    })
    if (won.count === 0) continue
    return {
      job: {
        id: next.id,
        sourceUrl: next.sourceUrl,
        skuCode: next.skuCode,
        attempts,
        requestedByName: next.requestedByName,
        store: { id: store.id, orderPrefix: store.orderPrefix, shop: store.shop },
        targets: settings.targets,
        force: next.force,
      },
      paused: false,
    }
  }
  return idle
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))

// `signal` is the runner's request: once it is aborted nothing more is claimed, because a claimed job whose answer reaches nobody
// would sit RUNNING for a whole lease and lose one of its two attempts.
export async function claimWithWait(waitSeconds: number, signal?: AbortSignal): Promise<ClaimResult> {
  const seconds = Number.isFinite(waitSeconds) ? Math.min(Math.max(waitSeconds, 0), CLONE_MAX_WAIT_S) : 0
  const deadline = Date.now() + seconds * 1000
  const gone = () => signal?.aborted === true
  // A paused answer waits out the window, so a runner that asks again at once does not spin.
  const settle = async (result: ClaimResult) => {
    if (result.paused) await sleep(deadline - Date.now())
    return result
  }
  if (gone()) return { job: null, paused: false }
  const first = await claimCloneJob()
  if (first.job || first.paused || seconds === 0) return settle(first)
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    // A wake-up with nobody waiting is not remembered, so the wait is registered before the second look:
    // a job created before that look is found by it, and one created after it wakes the wait.
    const woken = waitForCloneQueue(Math.max(0, deadline - Date.now()), stop.signal)
    if (gone()) return { job: null, paused: false }
    const second = await claimCloneJob()
    if (second.job || second.paused) return settle(second)
    await woken
    if (gone()) return { job: null, paused: false }
    return settle(await claimCloneJob())
  } finally {
    signal?.removeEventListener('abort', onAbort)
    stop.abort()
  }
}

const isAttempts = (v: unknown): v is number => Number.isInteger(v)

function stageOf(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const stage = v.normalize('NFC')
  return STAGES.includes(stage) ? stage : undefined
}

function platformOf(v: unknown): string | undefined {
  return typeof v === 'string' && PLATFORM_RE.test(v) ? v : undefined
}

function productGidOf(v: unknown): string | null {
  return typeof v === 'string' && PRODUCT_GID_RE.test(v) ? v : null
}

function amountOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function durationOf(v: unknown): number | null {
  const ms = amountOf(v)
  return ms !== null && Math.round(ms) <= MAX_INT ? Math.round(ms) : null
}

export async function heartbeatCloneJob(id: string, attempts: number, patch: { stage?: unknown; platform?: unknown }): Promise<{ ok: boolean; cancelled: boolean }> {
  await markWorkerSeen()
  if (isAttempts(attempts)) {
    const stage = stageOf(patch.stage)
    const platform = platformOf(patch.platform)
    const { count } = await prisma.cloneJob.updateMany({
      where: { id, status: 'RUNNING', attempts },
      data: { lockedAt: new Date(), ...(stage ? { stage } : {}), ...(platform ? { platform } : {}) },
    })
    if (count > 0) return { ok: true, cancelled: false }
  }
  const row = await prisma.cloneJob.findUnique({ where: { id }, select: { status: true } })
  return { ok: false, cancelled: row?.status === 'CANCELLED' }
}

export async function failCloneJob(
  id: string,
  attempts: number,
  input: { failKind: unknown; error: unknown; productGid?: unknown; retryable?: unknown },
): Promise<{ status: string } | null> {
  await markWorkerSeen()
  if (!isAttempts(attempts)) return null
  const productGid = productGidOf(input.productGid)
  const data = input.retryable === true && attempts < CLONE_MAX_ATTEMPTS
    ? { status: 'QUEUED', lockedAt: null, stage: null }
    : {
        status: 'FAILED',
        failKind: typeof input.failKind === 'string' && RUNNER_FAIL_KINDS.includes(input.failKind) ? input.failKind : 'TOOL',
        error: typeof input.error === 'string' ? input.error.slice(0, MAX_ERROR) : null,
        ...(productGid ? { productGid } : {}),
        lockedAt: null,
        finishedAt: new Date(),
      }
  const { count } = await prisma.cloneJob.updateMany({ where: { id, status: 'RUNNING', attempts }, data })
  return count > 0 ? { status: data.status } : null
}

export type ProductState = { status: string; onlineStoreUrl: string | null; handle: string; productType: string | null; skus: (string | null)[] } | null

const PRODUCT_STATE_QUERY = 'query($id: ID!, $after: String) { product(id: $id) { status onlineStoreUrl handle productType '
  + 'variants(first: 250, after: $after) { nodes { sku } pageInfo { hasNextPage endCursor } } } }'

type ProductPage = {
  status?: unknown; onlineStoreUrl?: unknown; handle?: unknown; productType?: unknown
  variants?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } }
}

const defaultVerifyLog = (message: string) => console.warn(`[clone verify] ${message}`)

// Throws when Shopify cannot be asked, so the caller keeps the job RUNNING. Every variant is read (up to 12 pages of 250): a product
// with more is also a throw, never a pass, because an unread variant could carry a foreign SKU.
export function makeShopifyProductState(opts: { fetchImpl?: FetchLike; log?: (message: string) => void } = {}): (storeId: string, gid: string) => Promise<ProductState> {
  const log = opts.log ?? defaultVerifyLog
  return async (storeId, gid) => {
    const fail = (reason: string) => {
      const message = `Không hỏi được Shopify của store ${storeId}: ${reason}`
      log(message)
      return new Error(message)
    }
    const unreadable = () => fail('Shopify trả về dữ liệu không đọc được')
    const skus: (string | null)[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_VARIANT_PAGES; page++) {
      const answer = await shopifyAdminGraphql(storeId, PRODUCT_STATE_QUERY, { id: gid, after }, { fetchImpl: opts.fetchImpl })
      if ('reason' in answer) throw fail(answer.reason)
      const data = answer.data
      if (typeof data !== 'object' || data === null || !('product' in data)) throw unreadable()
      if (data.product === null) return null
      const p = data.product as ProductPage | undefined
      const nodes = p?.variants?.nodes
      const more = p?.variants?.pageInfo?.hasNextPage
      const cursor = p?.variants?.pageInfo?.endCursor
      if (!p || typeof p.status !== 'string' || typeof p.handle !== 'string' || !Array.isArray(nodes) || typeof more !== 'boolean') throw unreadable()
      for (const node of nodes) {
        const sku = (node as { sku?: unknown } | null)?.sku
        skus.push(typeof sku === 'string' ? sku : null)
      }
      if (!more) {
        return {
          status: p.status,
          onlineStoreUrl: typeof p.onlineStoreUrl === 'string' && p.onlineStoreUrl ? p.onlineStoreUrl : null,
          handle: p.handle,
          productType: typeof p.productType === 'string' && p.productType ? p.productType : null,
          skus,
        }
      }
      if (typeof cursor !== 'string' || !cursor) throw unreadable()
      after = cursor
    }
    throw fail(`sản phẩm có hơn ${MAX_VARIANT_PAGES * 250} variant`)
  }
}

function verifyProblem(state: NonNullable<ProductState>, skuCode: string, reused: boolean): string | null {
  if (state.status !== 'ACTIVE') return NOT_ACTIVE
  if (!state.onlineStoreUrl) return NOT_ONLINE
  if (!reused && (state.skus.length === 0 || !state.skus.every(sku => skuBelongsTo(skuCode, sku)))) return FOREIGN_SKU
  return null
}

type CompleteResult = { status: 'DONE' | 'FAILED'; error?: string } | { retry: true; error: string } | null

// Spec 7.9: DONE only after the store's own Shopify answer shows the product ACTIVE, on the Online Store, and (unless reused)
// carrying only the issued SKU code. handle, productUrl and productType come from that answer, never from the runner.
export async function completeCloneJob(
  id: string,
  attempts: number,
  input: { productGid: unknown; handle?: unknown; qaVerdict: unknown; qaNote?: unknown; reused?: unknown; costUsd?: unknown; durationMs?: unknown },
  deps: { productState?: (storeId: string, gid: string) => Promise<ProductState> } = {},
): Promise<CompleteResult> {
  await markWorkerSeen()
  if (!isAttempts(attempts)) return null
  const row = await prisma.cloneJob.findUnique({ where: { id }, select: { storeId: true, skuCode: true, status: true, attempts: true } })
  if (!row || row.status !== 'RUNNING' || row.attempts !== attempts) return null

  const productGid = productGidOf(input.productGid)
  const reused = input.reused === true
  const passed = input.qaVerdict === 'PASS'
  const report = {
    reused,
    qaVerdict: passed ? 'PASS' : null,
    qaNote: typeof input.qaNote === 'string' ? input.qaNote.slice(0, MAX_QA_NOTE) : null,
    costUsd: amountOf(input.costUsd),
    durationMs: durationOf(input.durationMs),
    ...(productGid ? { productGid } : {}),
  }
  const write = async (data: Record<string, unknown>) => {
    const { count } = await prisma.cloneJob.updateMany({
      where: { id, status: 'RUNNING', attempts },
      data: { ...report, ...data, lockedAt: null, finishedAt: new Date() },
    })
    return count > 0
  }
  const fail = async (failKind: string, error: string): Promise<CompleteResult> =>
    (await write({ status: 'FAILED', failKind, error })) ? { status: 'FAILED', error } : null

  if (!passed) return fail('QA', QA_FAILED)
  if (!productGid) return fail('TOOL', BAD_PRODUCT_GID)

  let state: ProductState
  try {
    state = await (deps.productState ?? makeShopifyProductState())(row.storeId, productGid)
  } catch {
    return { retry: true, error: ASK_AGAIN }
  }
  if (!state) return fail('VERIFY', MISSING)
  const problem = verifyProblem(state, row.skuCode, reused)
  if (problem) return fail('VERIFY', problem)

  const done = await write({
    status: 'DONE', failKind: null, error: null, handle: state.handle, productUrl: state.onlineStoreUrl, productType: state.productType,
  })
  return done ? { status: 'DONE' } : null
}
