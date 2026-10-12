import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { loadTask, viewerFor } from '@/lib/design-tasks'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const detail = await loadTask(params.key)
  if (!detail) return NextResponse.json({ error: 'Task not found' }, { status: 404 })
  return NextResponse.json({ ...detail, me: viewerFor(user, detail.settings) })
}
