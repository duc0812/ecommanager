import { NextRequest, NextResponse } from 'next/server'
import { jsonBody, scaleError, superadmin } from '@/lib/scale/http'
import { deleteTarget, targetView, updateTarget } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    return NextResponse.json({ target: targetView(await updateTarget(params.id, body)) })
  } catch (err) { return scaleError(err) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  await deleteTarget(params.id)
  return NextResponse.json({ ok: true })
}
