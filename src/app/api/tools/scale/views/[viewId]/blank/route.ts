import { NextRequest, NextResponse } from 'next/server'
import { jsonBody, scaleError, superadmin } from '@/lib/scale/http'
import { getTarget, setViewBlank, targetView } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { viewId: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    const view = await setViewBlank(params.viewId, String(body.dataUrl ?? ''))
    return NextResponse.json({ target: targetView(await getTarget(view.targetId)) })
  } catch (err) { return scaleError(err) }
}
