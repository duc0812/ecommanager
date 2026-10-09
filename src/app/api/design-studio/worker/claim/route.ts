import { NextRequest, NextResponse } from 'next/server'
import { claimJob, parseJobKinds, verifyWorkerRequest } from '@/lib/artwork-worker'

export async function POST(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  const claimed = await claimJob(new Date(), parseJobKinds(body?.kinds))
  return NextResponse.json(claimed ?? { job: null })
}
