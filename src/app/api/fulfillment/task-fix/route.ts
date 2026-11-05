import { NextRequest, NextResponse } from 'next/server'
import { listOrderTasks, listDoneTasks, reconcileTaskStates } from '@/lib/repos/order-tasks'
import { requireScope } from '@/lib/order-scope'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'need_to_fix')
  if ('error' in scope) return scope.error
  const { storeIds } = scope
  const projectId = req.nextUrl.searchParams.get('projectId') ?? undefined
  const done = req.nextUrl.searchParams.get('done') === '1'

  // Reconcile persisted task states from the FULL (unfiltered) live open set so
  // tasks in other projects or stores aren't wrongly resolved, then answer this request.
  const all = await listOrderTasks()
  await reconcileTaskStates(all.rows)

  if (done) {
    const doneRows = await listDoneTasks({ projectId, storeIds })
    return NextResponse.json({ done: doneRows })
  }

  const rows = all.rows.filter(r => (!projectId || r.projectId === projectId) && (!storeIds || storeIds.includes(r.storeId)))
  const counts = {} as Record<string, number>
  for (const r of rows) counts[r.task.type] = (counts[r.task.type] ?? 0) + 1
  return NextResponse.json({ rows, counts })
}
