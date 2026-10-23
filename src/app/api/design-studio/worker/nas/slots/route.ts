import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { listNasSlots } from '@/lib/repos/artwork-nas'

export async function GET(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ slots: await listNasSlots() })
}
