import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireTaskScope } from '@/lib/order-scope'
import { receiveTaskArtwork } from '@/lib/task-artwork-upload'

/**
 * One file of a task. `kind` is PRINT (default) or MOCKUP. `printArea` names the part the file belongs to (a template area,
 * or the part being replaced); without it the part is read from the file name, so `front.png` + `back.png` are two files
 * and a second `front.png` is version 2 of "front".
 */
export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireTaskScope(req, params.key)
  if ('error' in scope) return scope.error

  const result = await receiveTaskArtwork(req, params.key, auth.user.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ artwork: result.artwork })
}
