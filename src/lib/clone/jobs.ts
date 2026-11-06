import type { CloneJob } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import type { AuthUser } from '@/lib/api-auth'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { storeScopeFor, storeWhere } from '@/lib/store-scope'
import { listConnectedStores } from '@/lib/store-connections'
import { issueSkuCode, parseSkuPrefix, type SkuCodeDeps } from '@/lib/clone/sku-code'

export type CloneJobRow = CloneJob

type SuperadminOnly = 'costUsd' | 'durationMs' | 'lockedAt' | 'qaNote' | 'productType'
type DateColumn = 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'

export type CloneJobView = Omit<CloneJobRow, DateColumn | SuperadminOnly> & {
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  costUsd?: number | null
  durationMs?: number | null
  lockedAt?: string | null
  qaNote?: string | null
  productType?: string | null
}

export class CloneInputError extends Error {
  status: number
  extra?: Record<string, unknown>

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.name = 'CloneInputError'
    this.status = status
    this.extra = extra
  }
}

const NOT_YOUR_STORE = 'Bạn không có quyền xem store này.'
const NO_SKU_PREFIX = 'Tài khoản chưa có mã SKU 2 chữ cái. Nhờ quản trị điền ở Setup › Users.'
const BAD_LINK = 'Link không hợp lệ.'
const JOB_NOT_FOUND = 'Không tìm thấy job.'
const NOT_WAITING = 'Chỉ huỷ được job đang chờ.'
const NOT_FAILED = 'Chỉ thử lại được job lỗi.'
const LIST_LIMIT = 200
const LINK_TAKEN = 'Link này đã có job khác.'
const NO_SKU_CODE = 'Không cấp được mã SKU, thử lại sau.'
const MAX_URL_LENGTH = 2048
const LIVE_STATUSES = ['QUEUED', 'RUNNING', 'DONE']
const ADMIN_ONLY_FAIL_KINDS = ['TOOL_GAP', 'UNSUPPORTED', 'NOT_ENABLED']
// The only failure texts the server itself writes; every other error comes from the runner or a Claude session on the owner's PC.
const SERVER_ERROR_KINDS = ['VERIFY', 'WORKER_LOST']

export function sourceKeyOf(url: string): string {
  const u = new URL(url.trim())
  return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

// Lists the columns on purpose: a column added to CloneJob later stays out of every response until it is added here.
// Only a SUPERADMIN gets the cost, the lease, the QA note and the product type, and `error` text that did not come from the server.
export function cloneJobView(job: CloneJobRow, viewer: AuthUser): CloneJobView {
  const superadmin = viewer.role === 'SUPERADMIN'
  const view: CloneJobView = {
    id: job.id,
    storeId: job.storeId,
    sourceUrl: job.sourceUrl,
    sourceKey: job.sourceKey,
    status: job.status,
    failKind: job.failKind,
    stage: job.stage,
    platform: job.platform,
    skuCode: job.skuCode,
    requestedById: job.requestedById,
    requestedByName: job.requestedByName,
    attempts: job.attempts,
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    productGid: job.productGid,
    handle: job.handle,
    productUrl: job.productUrl,
    reused: job.reused,
    qaVerdict: job.qaVerdict,
    error: superadmin || (job.failKind !== null && SERVER_ERROR_KINDS.includes(job.failKind)) ? job.error : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  }
  if (superadmin) {
    view.costUsd = job.costUsd
    view.durationMs = job.durationMs
    view.lockedAt = iso(job.lockedAt)
    view.qaNote = job.qaNote
    view.productType = job.productType
  }
  return view
}

declare global {
  // eslint-disable-next-line no-var
  var __cloneQueueWaiters: Set<() => void> | undefined
}

function waiters(): Set<() => void> {
  if (!globalThis.__cloneQueueWaiters) globalThis.__cloneQueueWaiters = new Set()
  return globalThis.__cloneQueueWaiters
}

// The waiter set lives on globalThis so every bundle copy of this module (Next.js emits several) and HMR share it.
export function notifyCloneQueue(): void {
  const set = waiters()
  const pending = Array.from(set)
  set.clear()
  for (const wake of pending) wake()
}

export function waitForCloneQueue(ms: number): Promise<void> {
  return new Promise(resolve => {
    const set = waiters()
    const wake = () => {
      clearTimeout(timer)
      set.delete(wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    set.add(wake)
  })
}

async function visibleWhere(user: AuthUser) {
  const scope = await storeScopeFor(user)
  const stores = storeWhere(scope.all ? null : scope.storeIds)
  return user.role === 'SELLER' ? { ...stores, requestedById: user.id } : stores
}

async function findVisible(user: AuthUser, id: string): Promise<CloneJobRow | null> {
  return prisma.cloneJob.findFirst({ where: { id, ...(await visibleWhere(user)) } })
}

export async function listCloneJobs(user: AuthUser): Promise<CloneJobView[]> {
  const rows = await prisma.cloneJob.findMany({ where: await visibleWhere(user), orderBy: { createdAt: 'desc' }, take: LIST_LIMIT })
  return rows.map(row => cloneJobView(row, user))
}

export async function getCloneJob(user: AuthUser, id: string): Promise<CloneJobView | null> {
  const row = await findVisible(user, id)
  return row ? cloneJobView(row, user) : null
}

export type CreateCloneJobDeps = { sku?: Partial<SkuCodeDeps>; now?: Date }

// A Claude session on the owner's PC types the stored link into a shell command, so it may hold only characters that are inert even unquoted.
export const SOURCE_URL_RE = /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~%+,@=:-]*)*(\?view=[A-Za-z0-9_-]+)?$/

const HOST_RE = /^[a-z0-9.-]+$/
const PATH_RE = /^(\/[A-Za-z0-9._~%+,@=:-]*)*$/
const VIEW_RE = /^[A-Za-z0-9_-]+$/

// The server rebuilds the link instead of storing what was pasted: ad query strings and the hash are dropped, and only a `view` parameter
// (some stores serve the personalised page behind a view template) survives. A link whose host or path holds anything else is refused.
export function normalizeSourceUrl(input: unknown): string {
  const bad = () => new CloneInputError(400, BAD_LINK)
  const typed = typeof input === 'string' ? input.trim() : ''
  if (typed.length > MAX_URL_LENGTH) throw bad()
  let url: URL
  try {
    url = assertSafeExternalUrl(typed)
  } catch {
    throw bad()
  }
  const host = url.hostname.toLowerCase()
  if (url.port || url.username || url.password || !HOST_RE.test(host) || !PATH_RE.test(url.pathname)) throw bad()
  const views = url.searchParams.getAll('view')
  const view = views.length === 1 && VIEW_RE.test(views[0]) ? `?view=${views[0]}` : ''
  const result = `https://${host}${url.pathname}${view}`
  if (result.length > MAX_URL_LENGTH || !SOURCE_URL_RE.test(result)) throw bad()
  return result
}

declare global {
  // eslint-disable-next-line no-var
  var __cloneLinkLocks: Map<string, Promise<void>> | undefined
}

// One create or retry per link at a time, so the next one sees the first one's job in its duplicate lookup. Memory is enough:
// production is a single process. State lives on globalThis for the same reason as the queue waiters.
async function withLinkLock<T>(storeId: string, sourceKey: string, run: () => Promise<T>): Promise<T> {
  if (!globalThis.__cloneLinkLocks) globalThis.__cloneLinkLocks = new Map()
  const locks = globalThis.__cloneLinkLocks
  const key = `${storeId}|${sourceKey}`
  const before = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = before.then(() => mine)
  locks.set(key, tail)
  await before
  try {
    return await run()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

export async function createCloneJob(
  user: AuthUser,
  input: { url: unknown; storeId: unknown; force?: unknown },
  deps: CreateCloneJobDeps = {},
): Promise<CloneJobRow> {
  const storeId = typeof input.storeId === 'string' ? input.storeId : ''
  const scope = await storeScopeFor(user)
  const allowed = scope.all || scope.storeIds.includes(storeId)
  if (!storeId || !allowed || !(await listConnectedStores()).some(s => s.id === storeId)) throw new CloneInputError(403, NOT_YOUR_STORE)

  const owner = await prisma.appUser.findUnique({ where: { id: user.id }, select: { skuPrefix: true } })
  const prefix = parseSkuPrefix(owner?.skuPrefix)
  if (!prefix) throw new CloneInputError(400, NO_SKU_PREFIX)

  const sourceUrl = normalizeSourceUrl(input.url)
  const sourceKey = sourceKeyOf(sourceUrl)

  return withLinkLock(storeId, sourceKey, async () => {
    if (!(input.force === true && user.role === 'SUPERADMIN')) {
      const same = await prisma.cloneJob.findMany({
        where: { storeId, sourceKey, status: { in: LIVE_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, requestedById: true, status: true, productUrl: true },
      })
      const own = same.find(j => j.requestedById === user.id)
      if (own) throw new CloneInputError(409, 'Bạn đã dán link này rồi.', { jobId: own.id })
      const done = same.find(j => j.status === 'DONE')
      if (done) throw new CloneInputError(409, 'Link này đã có sản phẩm trên store.', { productUrl: done.productUrl })
      if (same.length > 0) throw new CloneInputError(409, 'Link này đang được clone.')
    }

    // The code is checked for being free before it is used, so a unique-index hit here means someone took it in between: one more code, then give up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const skuCode = await issueSkuCode(prefix, deps.now ?? new Date(), deps.sku)
      try {
        const job = await prisma.cloneJob.create({
          data: { storeId, sourceUrl, sourceKey, skuCode, requestedById: user.id, requestedByName: user.name },
        })
        notifyCloneQueue()
        return job
      } catch (e) {
        if ((e as { code?: unknown }).code !== 'P2002') throw e
      }
    }
    throw new Error(NO_SKU_CODE)
  })
}

// A job the caller cannot see answers like a missing one; one it sees but did not create is only for a SUPERADMIN to act on.
async function findActionable(user: AuthUser, id: string, action: string): Promise<CloneJobRow> {
  const job = await findVisible(user, id)
  if (!job) throw new CloneInputError(404, JOB_NOT_FOUND)
  if (job.requestedById !== user.id && user.role !== 'SUPERADMIN') throw new CloneInputError(403, `Bạn không có quyền ${action} job này.`)
  return job
}

export async function cancelCloneJob(user: AuthUser, id: string): Promise<CloneJobView> {
  const job = await findActionable(user, id, 'huỷ')
  if (job.status !== 'QUEUED') throw new CloneInputError(409, NOT_WAITING)
  const { count } = await prisma.cloneJob.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: new Date() } })
  if (count === 0) throw new CloneInputError(409, NOT_WAITING)
  return cloneJobView(await prisma.cloneJob.findUniqueOrThrow({ where: { id } }), user)
}

export async function retryCloneJob(user: AuthUser, id: string): Promise<CloneJobView> {
  const job = await findActionable(user, id, 'thử lại')
  if (job.status !== 'FAILED') throw new CloneInputError(409, NOT_FAILED)
  if (job.failKind && ADMIN_ONLY_FAIL_KINDS.includes(job.failKind) && user.role !== 'SUPERADMIN') {
    throw new CloneInputError(403, 'Job này cần quản trị xử lý trước khi thử lại.')
  }
  await withLinkLock(job.storeId, job.sourceKey, async () => {
    const other = await prisma.cloneJob.findFirst({
      where: { id: { not: id }, storeId: job.storeId, sourceKey: job.sourceKey, status: { in: LIVE_STATUSES } },
      select: { id: true },
    })
    if (other) throw new CloneInputError(409, LINK_TAKEN)
    const { count } = await prisma.cloneJob.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'QUEUED', attempts: 0, error: null, failKind: null, stage: null, lockedAt: null, finishedAt: null },
    })
    if (count === 0) throw new CloneInputError(409, NOT_FAILED)
  })
  notifyCloneQueue()
  return cloneJobView(await prisma.cloneJob.findUniqueOrThrow({ where: { id } }), user)
}
