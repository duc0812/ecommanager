import { NextRequest, NextResponse } from 'next/server'
import { scaleError, staff } from '@/lib/scale/http'
import { rerunScaleJob, scaleJobView } from '@/lib/scale/jobs'
import { loadScaleDeps } from '@/lib/scale/settings'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  try {
    const job = await rerunScaleJob(params.id, auth.user.id, await loadScaleDeps())
    return NextResponse.json({ job: { ...scaleJobView(job), createdByName: auth.user.name } })
  } catch (err) { return scaleError(err) }
}
