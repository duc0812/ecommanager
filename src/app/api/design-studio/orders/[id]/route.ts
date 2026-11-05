import { NextRequest, NextResponse } from 'next/server'
import { requireOrderScope } from '@/lib/order-scope'
import { loadWorkspace } from '@/lib/design-studio'
import { fillCustomallFields } from '@/lib/customall-fields'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const scope = await requireOrderScope(req, params.id)
  if ('error' in scope) return scope.error
  await fillCustomallFields([params.id], { throttle: true }).catch(() => null)
  const ws = await loadWorkspace(params.id)
  if (!ws) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  return NextResponse.json(ws)
}
