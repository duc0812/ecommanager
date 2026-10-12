import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { loadTask, viewerFor } from '@/lib/design-tasks'
import { handoffStateFor } from '@/lib/supplier-handoff'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const detail = await loadTask(params.key)
  if (!detail) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  return NextResponse.json({ ...detail, handoff: await handoffStateFor(detail.task.orderId), me: viewerFor(user, detail.settings) })
}
