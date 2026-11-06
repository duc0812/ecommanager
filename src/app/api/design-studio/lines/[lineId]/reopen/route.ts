import { NextRequest, NextResponse } from 'next/server'
import { requireLineScope } from '@/lib/order-scope'
import { LineFixError, reopenLineForFix } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { lineId: string } }) {
  const scope = await requireLineScope(req, params.lineId)
  if ('error' in scope) return scope.error
  const { user } = scope
  const body = await req.json().catch(() => ({} as any))
  try {
    const result = await reopenLineForFix(params.lineId, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }, { reason: body?.reason, note: body?.note })
    return NextResponse.json(result)
  } catch (e: any) {
    if (e instanceof LineFixError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error(`[design studio] reopen line ${params.lineId} failed:`, e)
    return NextResponse.json({ error: 'Không mở lại được dòng — thử lại sau' }, { status: 500 })
  }
}
