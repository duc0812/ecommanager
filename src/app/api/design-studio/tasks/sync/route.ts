import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { syncDesignTasks } from '@/lib/design-tasks'
import { getLastDesignTaskSync, runDesignTaskSyncJob } from '@/lib/design-task-sync'

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  return NextResponse.json({ lastSync: await getLastDesignTaskSync() })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({} as any))
  const orderId = typeof body?.orderId === 'string' && body.orderId ? body.orderId : undefined

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
