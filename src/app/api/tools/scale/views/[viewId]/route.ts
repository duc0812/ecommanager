import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { jsonBody, scaleError, superadmin } from '@/lib/scale/http'
import { deleteView, getTarget, targetView, updateView } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

type Ctx = { params: { viewId: string } }

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    const view = await updateView(params.viewId, body)
    return NextResponse.json({ target: targetView(await getTarget(view.targetId)) })
  } catch (err) { return scaleError(err) }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    const view = await prisma.scaleTargetView.findUnique({ where: { id: params.viewId }, select: { targetId: true } })
    await deleteView(params.viewId)
    return NextResponse.json({ target: view ? targetView(await getTarget(view.targetId)) : null })
  } catch (err) { return scaleError(err) }
}
