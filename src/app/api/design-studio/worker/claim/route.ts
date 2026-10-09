import { NextRequest, NextResponse } from 'next/server'
import { claimJob, verifyWorkerRequest } from '@/lib/artwork-worker'

export async function POST(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const claimed = await claimJob()
  return NextResponse.json(claimed ?? { job: null })
}
