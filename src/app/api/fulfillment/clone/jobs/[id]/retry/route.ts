import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { retryCloneJob } from '@/lib/clone/jobs'
import { cloneErrorResponse } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json({ job: await retryCloneJob(auth.user, params.id) })
  } catch (e) {
    return cloneErrorResponse(e)
  }
}
