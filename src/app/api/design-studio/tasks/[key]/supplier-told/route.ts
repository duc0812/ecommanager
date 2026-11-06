import { NextRequest, NextResponse } from 'next/server'
import { requireTaskScope } from '@/lib/order-scope'
import { LineFixError, markSupplierTold } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const scope = await requireTaskScope(req, params.key)
  if ('error' in scope) return scope.error
  const { user } = scope
  try {
    return NextResponse.json(await markSupplierTold(params.key, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }))
  } catch (e: any) {
    if (e instanceof LineFixError) return NextResponse.json({ error: e.message }, { status: e.status })
    if (e?.message === 'Task not found') return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
    console.error(`[design studio] supplier told ${params.key} failed:`, e)
    return NextResponse.json({ error: 'Không ghi được "Đã báo xưởng" — thử lại sau' }, { status: 500 })
  }
}
