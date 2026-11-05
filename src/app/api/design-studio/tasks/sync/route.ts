import { NextRequest, NextResponse } from 'next/server'
import { requireEveryStore, requireOrderScope, requireScope } from '@/lib/order-scope'
import { syncDesignTasks } from '@/lib/design-tasks'
import { getLastDesignTaskSync, runDesignTaskSyncJob } from '@/lib/design-task-sync'

export async function GET(req: NextRequest) {
  const scope = await requireScope(req, 'design_tasks')
  if ('error' in scope) return scope.error
  return NextResponse.json({ lastSync: await getLastDesignTaskSync({ hideError: scope.limited }) })
}

// One order is checked against the stores of the caller; the run over every order is for those who see every store.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any))
  const orderId = typeof body?.orderId === 'string' && body.orderId ? body.orderId : undefined

  const allowed = orderId ? await requireOrderScope(req, orderId) : await requireEveryStore(req)
  if ('error' in allowed) return allowed.error

  if (orderId) {
    const r = await syncDesignTasks(orderId)
    return NextResponse.json({ ...r, orders: 1 })
  }

  const outcome = await runDesignTaskSyncJob('manual')
  if (outcome.skipped) {
    return NextResponse.json({ error: 'Đang có một lượt đồng bộ task chạy (tự động mỗi 15 phút hoặc người khác vừa bấm) — thử lại sau ít phút' }, { status: 409 })
  }
  return NextResponse.json(outcome.result)
}
