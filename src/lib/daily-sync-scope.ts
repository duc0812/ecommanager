import { prisma } from '@/lib/db'
import type { DailySyncResult } from '@/lib/daily-sync'
import { projectRowsWhere, type FinanceScope } from '@/lib/finance-scope'

const STEP_FAILED = 'Bước này lỗi, báo Admin.'

type BillingAccount = { accountId?: string; accountName?: string | null; status?: string; error?: string | null }

// The billing line of a run, worked out again from the accounts in scope. The job's own status and timeout flag describe
// every account, so a failure of another store must not show here. Accounts are picked by their Meta account id, not by name.
function billingForAccounts(step: any, accountIds: Set<string>) {
  const mine: BillingAccount[] = (Array.isArray(step.accounts) ? step.accounts : []).filter((a: BillingAccount) => a?.accountId && accountIds.has(a.accountId))
  if (mine.length === 0) return { skipped: true, reason: 'Chưa có dữ liệu billing của account thuộc store này' }
  const failed = mine.filter(a => a.status === 'FAILED').length
  const pending = mine.filter(a => a.status === 'QUEUED' || a.status === 'RUNNING').length
  const status = pending > 0
    ? (step.timedOut ? 'RUNNING' : 'INTERRUPTED')
    : failed === 0 ? 'COMPLETED' : failed === mine.length ? 'FAILED' : 'COMPLETED_WITH_ERRORS'
  return {
    status,
    ...(pending > 0 && step.timedOut ? { timedOut: true } : {}),
    accountErrors: mine.filter(a => a.error).map(a => ({ account: a.accountName, error: a.error })),
  }
}

// The saved daily run covers every store. A caller limited to some stores gets the lines about its own stores,
// accounts and projects, matched by id; the counters that add up across stores are left out because they cannot be split again.
export async function dailySyncForScope(last: DailySyncResult | null, scope: FinanceScope): Promise<DailySyncResult | null> {
  if (!last || !scope.projectIds || !scope.storeIds) return last
  const storeIds = scope.storeIds
  const projectIds = new Set(scope.projectIds)
  const accounts = await prisma.metaAdAccount.findMany({ where: projectRowsWhere(scope), select: { accountId: true } })
  const accountIds = new Set(accounts.map(a => a.accountId))
  const steps: Record<string, any> = {}
  let ok = true

  for (const [name, step] of Object.entries(last.steps ?? {}) as [string, any][]) {
    if (!step || typeof step !== 'object') { steps[name] = step; continue }
    if (typeof step.error === 'string') { steps[name] = { error: STEP_FAILED }; ok = false; continue }
    if (step.skipped) { steps[name] = step; continue }
    if (name === 'payouts') {
      const mine = (Array.isArray(step.stores) ? step.stores : []).filter((s: any) => storeIds.includes(s?.storeId))
      if (mine.some((s: any) => s.ok === false)) ok = false
      steps[name] = { stores: mine }
    } else if (name === 'billing') {
      steps[name] = billingForAccounts(step, accountIds)
    } else if (name === 'reserve') {
      steps[name] = {
        refreshed: (Array.isArray(step.refreshed) ? step.refreshed : []).filter((id: string) => accountIds.has(id)),
        errors: (Array.isArray(step.errors) ? step.errors : []).filter((e: any) => accountIds.has(e?.accountId)),
      }
    } else if (name === 'snapshot') {
      const closedIds: string[] = Array.isArray(step.closedIds) ? step.closedIds : []
      steps[name] = {
        periodMonth: step.periodMonth,
        closed: (Array.isArray(step.closed) ? step.closed : []).filter((_: string, i: number) => projectIds.has(closedIds[i])),
        errors: (Array.isArray(step.errors) ? step.errors : []).filter((e: any) => projectIds.has(e?.projectId)),
      }
    }
  }

  return { startedAt: last.startedAt, finishedAt: last.finishedAt, ok, steps: steps as DailySyncResult['steps'] }
}
