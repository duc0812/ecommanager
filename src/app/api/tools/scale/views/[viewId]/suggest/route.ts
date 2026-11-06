import { NextRequest, NextResponse } from 'next/server'
import { scaleError, superadmin } from '@/lib/scale/http'
import { loadScaleDeps } from '@/lib/scale/settings'
import { suggestViewDescription } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { viewId: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json(await suggestViewDescription(params.viewId, await loadScaleDeps()))
  } catch (err) { return scaleError(err) }
}
