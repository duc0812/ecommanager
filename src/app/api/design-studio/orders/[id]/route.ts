import { NextRequest, NextResponse } from 'next/server'
import { loadWorkspace } from '@/lib/design-studio'
import { fillCustomallFields } from '@/lib/customall-fields'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  await fillCustomallFields([params.id], { throttle: true }).catch(() => null)
  const ws = await loadWorkspace(params.id)
  if (!ws) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  return NextResponse.json(ws)
}
