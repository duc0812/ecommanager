import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { queueScheduledRenders } from '@/lib/repos/artwork-render'

export async function POST(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await queueScheduledRenders())
}
