export type CloneStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

export type CloneJobView = {
  id: string
  storeId: string
  sourceUrl: string
  status: CloneStatus
  failKind: string | null
  stage: string | null
  skuCode: string | null
  requestedById: string
  requestedByName: string
  productUrl: string | null
  productGid: string | null
  reused: boolean
  error: string | null
  createdAt: string
  costUsd?: number | null
  durationMs?: number | null
  productType?: string | null
}

export type CloneStore = { id: string; shop: string; orderPrefix: string | null }

export type CloneWorkerState = { online: boolean; lastSeenAt: string | null }

export type CloneJobsResponse = {
  jobs: CloneJobView[]
  worker: CloneWorkerState
  stores: CloneStore[]
  hasSkuPrefix: boolean
  paused: boolean
}

export type CloneSettingsView = {
  paused: boolean
  targets: string[]
  worker: { configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }
}

export const STATUS_LABEL: Record<CloneStatus, string> = {
  QUEUED: 'Đang chờ',
  RUNNING: 'Đang chạy',
  DONE: 'Xong',
  FAILED: 'Lỗi',
  CANCELLED: 'Đã huỷ',
}

export const FAIL_KIND_LABEL: Record<string, string> = {
  UNSUPPORTED: 'Nền tảng chưa hỗ trợ',
  NOT_ENABLED: 'Nền tảng chưa bật cho store này',
  SOURCE: 'Link không mở được',
  TOOL_GAP: 'Cần nâng cấp tool, đang chờ owner',
  QA: 'QA không đạt',
  VERIFY: 'Kiểm tra trên Shopify không đạt',
  TIMEOUT: 'Quá thời gian',
  WORKER_LOST: 'Máy xử lý mất kết nối',
  TOOL: 'Tool báo lỗi',
}

export const PLATFORMS = ['customily', 'customall', 'teeinblue', 'customix'] as const

export const NO_SKU_PREFIX_MESSAGE = 'Tài khoản chưa có mã SKU 2 chữ cái. Nhờ quản trị điền ở Setup › Users.'
export const NETWORK_ERROR = 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'

const ADMIN_ONLY_FAIL_KINDS = ['TOOL_GAP', 'UNSUPPORTED', 'NOT_ENABLED']

export type Viewer = { id: string | null; role: string | null; superadmin: boolean }

export const isActive = (job: CloneJobView) => job.status === 'QUEUED' || job.status === 'RUNNING'

export const visibleStage = (job: CloneJobView): string | null => (job.status === 'RUNNING' ? job.stage : null)

export const showsReused = (job: CloneJobView): boolean => job.status === 'DONE' && job.reused

const productIdOf = (job: CloneJobView) => /^gid:\/\/shopify\/Product\/(\d+)$/.exec(job.productGid ?? '')?.[1] ?? null

// The same rule as retryCloneJob: a failed job that made a product left it on the store. A reused job made none (its gid is the
// original product) and a VERIFY fail names whatever the runner reported, which may not be this job's.
const leftProduct = (job: CloneJobView) => job.status === 'FAILED' && job.productGid !== null && !job.reused && job.failKind !== 'VERIFY'

// Only the SUPERADMIN is shown which product a failed job left behind.
export function leftoverProductId(job: CloneJobView, viewer: Viewer): string | null {
  return viewer.superadmin && leftProduct(job) ? productIdOf(job) : null
}

// Any other product a failed job names, shown to the SUPERADMIN without advice.
export function reportedProductId(job: CloneJobView, viewer: Viewer): string | null {
  return viewer.superadmin && job.status === 'FAILED' && !leftProduct(job) ? productIdOf(job) : null
}

// The same rules as cancelCloneJob and retryCloneJob, so a click never answers 403.
export function canCancel(job: CloneJobView, viewer: Viewer): boolean {
  return job.status === 'QUEUED' && (viewer.superadmin || (viewer.id !== null && job.requestedById === viewer.id))
}

export function canRetry(job: CloneJobView, viewer: Viewer): boolean {
  if (job.status !== 'FAILED') return false
  if (viewer.superadmin) return true
  const adminOnly = (job.failKind !== null && ADMIN_ONLY_FAIL_KINDS.includes(job.failKind)) || leftProduct(job)
  return viewer.id !== null && job.requestedById === viewer.id && !adminOnly
}

// Retrying a job that left a product behind makes a second one, so the SUPERADMIN is asked first.
export function retryQuestion(job: CloneJobView, viewer: Viewer): string | null {
  const id = leftoverProductId(job, viewer)
  return id ? `Job này còn sản phẩm ${id} trên store. Xoá hoặc chuyển nháp sản phẩm đó trước khi thử lại. Thử lại bây giờ?` : null
}

// The prefix a pair is saved under: uppercase letters only, which is what the settings route accepts.
export function prefixOf(store: CloneStore): string | null {
  const prefix = store.orderPrefix?.trim().toUpperCase() ?? ''
  return /^[A-Z]+$/.test(prefix) ? prefix : null
}

const WHEN = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function formatWhen(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return '—'
  const part = Object.fromEntries(WHEN.formatToParts(date).map(p => [p.type, p.value]))
  return `${part.month}/${part.day}/${part.year} ${part.hour}:${part.minute}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  return minutes > 0 ? `${minutes}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`
}

export function httpsUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : undefined
}

export async function requestJson(url: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const hasBody = init.body !== undefined
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    cache: 'no-store',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body: body ?? {} }
}
