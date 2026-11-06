import { NextRequest, NextResponse } from 'next/server'
import { scaleError, staff } from '@/lib/scale/http'
import { retryFailedViews, scaleJobView } from '@/lib/scale/jobs'
import { loadScaleDeps } from '@/lib/scale/settings'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await staff(req)
  if ('error' in auth) return auth.error
  try {
    const job = await retryFailedViews(params.id, await loadScaleDeps())
    return NextResponse.json({ job: scaleJobView(job) })
  } catch (err) { return scaleError(err) }
}
