import { prisma } from '@/lib/db'
import type { DailySyncResult } from '@/lib/daily-sync'
import { projectRowsWhere, type FinanceScope } from '@/lib/finance-scope'

const STEP_FAILED = 'Bước này lỗi, báo Admin.'

// The saved daily run covers every store. A caller limited to some stores gets the lines about its own stores,
// accounts and projects; the counters that add up across stores are left out because they cannot be split again.
export async function dailySyncForScope(last: DailySyncResult | null, scope: FinanceScope): Promise<DailySyncResult | null> {
  if (!last || !scope.projectIds || !scope.storeIds) return last
  const storeIds = scope.storeIds
  const [accounts, projects] = await Promise.all([
    prisma.metaAdAccount.findMany({ where: projectRowsWhere(scope), select: { accountId: true, accountName: true } }),
    prisma.project.findMany({ where: { id: { in: scope.projectIds } }, select: { name: true } }),
  ])
  const accountIds = new Set(accounts.map(a => a.accountId))
  const accountNames = new Set(accounts.map(a => a.accountName || a.accountId))
  const projectNames = new Set(projects.map(p => p.name))
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
      steps[name] = {
        status: step.status,
        ...(step.timedOut ? { timedOut: true } : {}),
        accountErrors: (Array.isArray(step.accountErrors) ? step.accountErrors : []).filter((e: any) => accountNames.has(e?.account)),
      }
    } else if (name === 'reserve') {
      steps[name] = {
        refreshed: (Array.isArray(step.refreshed) ? step.refreshed : []).filter((id: string) => accountIds.has(id)),
        errors: (Array.isArray(step.errors) ? step.errors : []).filter((e: any) => accountIds.has(e?.accountId)),
      }
    } else if (name === 'snapshot') {
      steps[name] = {
        periodMonth: step.periodMonth,
        closed: (Array.isArray(step.closed) ? step.closed : []).filter((n: string) => projectNames.has(n)),
        errors: (Array.isArray(step.errors) ? step.errors : []).filter((e: any) => projectNames.has(e?.project)),
      }
    }
  }

  return { startedAt: last.startedAt, finishedAt: last.finishedAt, ok, steps: steps as DailySyncResult['steps'] }
}
