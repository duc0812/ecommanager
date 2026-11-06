import { NextRequest, NextResponse } from 'next/server'
import { jsonBody, scaleError, superadmin } from '@/lib/scale/http'
import { loadScaleDeps } from '@/lib/scale/settings'
import { acceptCandidate, discardCandidate, refreshCandidate, startCandidate, targetView } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

type Ctx = { params: { id: string } }

export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json({ target: targetView(await refreshCandidate(params.id, await loadScaleDeps())) })
  } catch (err) { return scaleError(err) }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    return NextResponse.json({ target: targetView(await startCandidate(params.id, String(body.dataUrl ?? ''), await loadScaleDeps())) })
  } catch (err) { return scaleError(err) }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json({ target: targetView(await acceptCandidate(params.id)) })
  } catch (err) { return scaleError(err) }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json({ target: targetView(await discardCandidate(params.id)) })
  } catch (err) { return scaleError(err) }
}
