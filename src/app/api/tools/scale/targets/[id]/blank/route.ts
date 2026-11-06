import { NextRequest, NextResponse } from 'next/server'
import { jsonBody, scaleError, superadmin } from '@/lib/scale/http'
import { setBlank, targetView } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    return NextResponse.json({ target: targetView(await setBlank(params.id, String(body.dataUrl ?? ''))) })
  } catch (err) { return scaleError(err) }
}
