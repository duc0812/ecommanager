import { NextRequest, NextResponse } from 'next/server'
import { jsonBody, scaleError, staff, superadmin } from '@/lib/scale/http'
import { createTarget, listTargets, staffTargetView, targetView } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  const full = auth.user.role === 'SUPERADMIN'
  const targets = await listTargets({ readyOnly: !full })
  return NextResponse.json({ targets: full ? targets.map(targetView) : targets.map(staffTargetView) })
}

export async function POST(req: NextRequest) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  const body = await jsonBody(req)
  try {
    return NextResponse.json({ target: targetView(await createTarget({ name: String(body.name ?? ''), sku: String(body.sku ?? '') })) })
  } catch (err) { return scaleError(err) }
}
