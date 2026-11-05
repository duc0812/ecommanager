import { NextRequest, NextResponse } from 'next/server'
import { requireTaskScope } from '@/lib/order-scope'
import { releaseLibraryTask } from '@/lib/design-tasks'

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const scope = await requireTaskScope(req, params.key)
  if ('error' in scope) return scope.error
  const { user } = scope
  try {
    return NextResponse.json(await releaseLibraryTask(params.key, { id: user.id, name: user.name, role: user.role, permissions: user.permissions }))
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: /not found/i.test(e.message) ? 404 : 400 })
  }
}
