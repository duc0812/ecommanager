import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { JOB_NOT_FOUND, getCloneJob } from '@/lib/clone/jobs'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const job = await getCloneJob(auth.user, params.id)
  if (!job) return NextResponse.json({ error: JOB_NOT_FOUND }, { status: 404 })
  return NextResponse.json({ job })
}
