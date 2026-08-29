import { NextRequest, NextResponse } from 'next/server'
import { listOrderTasks, listDoneTasks, reconcileTaskStates } from '@/lib/repos/order-tasks'

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') ?? undefined
  const done = req.nextUrl.searchParams.get('done') === '1'

  // Reconcile persisted task states from the FULL (unfiltered) live open set so
  // tasks in other projects aren't wrongly resolved, then answer this request.
  const all = await listOrderTasks()
  await reconcileTaskStates(all.rows)

  if (done) {
    const doneRows = await listDoneTasks({ projectId })
    return NextResponse.json({ done: doneRows })
  }

  const rows = projectId ? all.rows.filter(r => r.projectId === projectId) : all.rows
  const counts = {} as Record<string, number>
  for (const r of rows) counts[r.task.type] = (counts[r.task.type] ?? 0) + 1
  return NextResponse.json({ rows, counts })
}
