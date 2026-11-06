import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess, requireSuperadmin, type AuthUser } from '@/lib/api-auth'
import { ScaleInputError } from '@/lib/scale/settings'

type Auth = { user: AuthUser } | { error: NextResponse }

export function scaleError(err: any): NextResponse {
  if (err instanceof ScaleInputError) return NextResponse.json({ error: err.message }, { status: 400 })
  return NextResponse.json({ error: String(err?.message ?? err) }, { status: 502 })
}

// Routes under jobs/ and targets/ are excluded from the middleware matcher (large image bodies), so access is checked here.
export function staff(req: NextRequest): Promise<Auth> {
  return requireApiAccess(req)
}

export async function superadmin(req: NextRequest): Promise<Auth> {
  const access = await requireApiAccess(req)
  if ('error' in access) return access
  return requireSuperadmin(req)
}

export async function jsonBody(req: NextRequest): Promise<any> {
  const body = await req.json().catch(() => null)
  return body && typeof body === 'object' ? body : {}
}
