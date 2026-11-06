import { NextRequest, NextResponse } from 'next/server'
import { scaleError, staff } from '@/lib/scale/http'
import { deleteScaleJob, refreshScaleJob, scaleJobView } from '@/lib/scale/jobs'
import { loadScaleDeps } from '@/lib/scale/settings'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  try {
    const job = await refreshScaleJob(params.id, await loadScaleDeps())
    return NextResponse.json({ job: scaleJobView(job, { debug: auth.user.role === 'SUPERADMIN' }) })
  } catch (err) { return scaleError(err) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  try {
    await deleteScaleJob(params.id, auth.user)
    return NextResponse.json({ ok: true })
  } catch (err) { return scaleError(err) }
}
