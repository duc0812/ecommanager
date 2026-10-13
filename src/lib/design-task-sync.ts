import { prisma } from '@/lib/db'
import { runExclusive } from '@/lib/job-lock'
import { syncDesignTasks } from '@/lib/design-tasks'
import { needsLineProps, refreshMissingLineProps } from '@/lib/design-studio'

export const DESIGN_TASK_SYNC_KEY = 'last_design_task_sync_result'
export const DESIGN_TASK_SYNC_JOB = 'design-task-sync'
export const RECENT_ORDERS = 100
export const REFRESH_BATCH = 25
export const REFRESH_MAX_ORDERS = 100
const REFRESH_RETRY_MS = 6 * 3600_000
const DESIGN_STATUSES = ['PENDING_DESIGN', 'DESIGN_REJECTED']
const OPEN_TASK_STATUSES = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER']

export type SyncTrigger = 'manual' | 'schedule'
export type RefreshSummary = {
  needing: number; attempted: number; deferred: number
  refreshed: number; notFound: number; otherStore: number; error: string | null
}
export type DesignTaskSyncSummary = {
  trigger: SyncTrigger; startedAt: string; ranAt: string
  orders: number; scope: { design: number; openTasks: number; recent: number }
  created: number; cancelled: number; completed: number; reopened: number
  refresh: RefreshSummary; errors: string[]
}

declare global {
  // eslint-disable-next-line no-var
  var __designSyncRefreshAttempts: Map<string, number> | undefined
}

function refreshAttempts(): Map<string, number> {
  if (!globalThis.__designSyncRefreshAttempts) globalThis.__designSyncRefreshAttempts = new Map()
  return globalThis.__designSyncRefreshAttempts
}

const ORDER_SELECT = {
  id: true, shopifyOrderNumber: true, placedAt: true,
  store: { select: { shop: true } },
  lines: { select: { customAttributesJson: true, imageUrl: true, shopifyProductId: true } },
} as const

/**
 * Every order still waiting for a design, every order with an open task, plus the newest orders.
 * Nothing is deleted: a task only changes through syncDesignTasks.
 */
export async function runDesignTaskSync(opts: { trigger?: SyncTrigger; now?: number } = {}): Promise<DesignTaskSyncSummary> {
  const trigger = opts.trigger ?? 'manual'
  const now = opts.now ?? Date.now()
  const startedAt = new Date().toISOString()

  const [backlog, recent, design, openTasks] = await Promise.all([
    prisma.order.findMany({
      where: { OR: [{ pipelineStatus: { in: DESIGN_STATUSES } }, { designTasks: { some: { status: { in: OPEN_TASK_STATUSES } } } }] },
      select: ORDER_SELECT,
    }),
    prisma.order.findMany({ orderBy: { placedAt: 'desc' }, take: RECENT_ORDERS, select: ORDER_SELECT }),
    prisma.order.count({ where: { pipelineStatus: { in: DESIGN_STATUSES } } }),
    prisma.order.count({ where: { designTasks: { some: { status: { in: OPEN_TASK_STATUSES } } } } }),
  ])
  const byId = new Map([...backlog, ...recent].map(o => [o.id, o]))
  const orders = Array.from(byId.values()).sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())

  const refresh: RefreshSummary = { needing: 0, attempted: 0, deferred: 0, refreshed: 0, notFound: 0, otherStore: 0, error: null }
  const attempts = refreshAttempts()
  const needing = orders.filter(needsLineProps)
  refresh.needing = needing.length
  // A scheduled run asks Shopify about an order at most once per retry window, so orders Shopify no longer returns do not starve the rest.
  const due = trigger === 'manual' ? needing : needing.filter(o => {
    const last = attempts.get(o.id)
    return last === undefined || now - last >= REFRESH_RETRY_MS
  })
  const picked = due.slice(0, REFRESH_MAX_ORDERS)
  refresh.deferred = needing.length - picked.length
  for (let i = 0; i < picked.length; i += REFRESH_BATCH) {
    const batch = picked.slice(i, i + REFRESH_BATCH)
    const r = await refreshMissingLineProps(batch)
    if (r.error) { refresh.error = r.error; refresh.deferred += picked.length - i; break }
    for (const o of batch) attempts.set(o.id, now)
    refresh.attempted += batch.length
    refresh.refreshed += r.refreshed
    refresh.notFound += r.notFound
    refresh.otherStore += r.otherStore
  }

  let created = 0, cancelled = 0, completed = 0, reopened = 0
  const errors: string[] = []
  for (const o of orders) {
    try {
      const r = await syncDesignTasks(o.id)
      created += r.created
      cancelled += r.cancelled
      completed += r.completed
      reopened += r.reopened
    } catch (e: any) {
      errors.push(`${o.shopifyOrderNumber}: ${e.message}`)
    }
  }
  return {
    trigger, startedAt, ranAt: new Date().toISOString(),
    orders: orders.length, scope: { design, openTasks, recent: recent.length },
    created, cancelled, completed, reopened, refresh, errors,
  }
}

async function saveLast(value: unknown) {
  const json = JSON.stringify(value)
  await prisma.appSetting.upsert({ where: { key: DESIGN_TASK_SYNC_KEY }, create: { key: DESIGN_TASK_SYNC_KEY, value: json }, update: { value: json } })
}

/** One run at a time in this process — the 15-minute schedule and the "Đồng bộ task" button share the lock. */
export async function runDesignTaskSyncJob(trigger: SyncTrigger) {
  return runExclusive(DESIGN_TASK_SYNC_JOB, async () => {
    try {
      const summary = await runDesignTaskSync({ trigger })
      await saveLast({ ...summary, errors: summary.errors.slice(0, 20), errorCount: summary.errors.length })
      return summary
    } catch (e: any) {
      await saveLast({ trigger, ranAt: new Date().toISOString(), error: e?.message ?? String(e) }).catch(() => {})
      throw e
    }
  })
}

export type LastDesignTaskSync = { ranAt: string; trigger: SyncTrigger; error: string | null }

export async function getLastDesignTaskSync(): Promise<LastDesignTaskSync | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: DESIGN_TASK_SYNC_KEY } })
  if (!row) return null
  try {
    const v = JSON.parse(row.value)
    if (typeof v?.ranAt !== 'string') return null
    return { ranAt: v.ranAt, trigger: v.trigger === 'schedule' ? 'schedule' : 'manual', error: typeof v.error === 'string' ? v.error : null }
  } catch { return null }
}
