import { NextRequest, NextResponse } from 'next/server'
import { scaleError, superadmin } from '@/lib/scale/http'
import { loadScaleDeps } from '@/lib/scale/settings'
import { suggestDescription } from '@/lib/scale/targets'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await superadmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json(await suggestDescription(params.id, await loadScaleDeps()))
  } catch (err) { return scaleError(err) }
}
