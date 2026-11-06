import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { createTask, listTasks } from '@/lib/cs/tasks'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  return NextResponse.json({ tasks: await listTasks({ dept: p.get('dept') || undefined, type: p.get('type') || undefined }) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  try {
    const task = await createTask({ ticketId: body.ticketId ?? null, orderNumber: body.orderNumber ?? null, type: String(body.type ?? ''), detail: String(body.detail ?? ''), dept: body.dept || undefined, amount: body.amount ?? null }, { id: user.id, name: user.name })
    return NextResponse.json({ task })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Không tạo được task' }, { status: 400 })
  }
}
