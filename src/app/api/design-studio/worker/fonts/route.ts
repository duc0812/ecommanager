import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest, workerFonts } from '@/lib/artwork-worker'

export async function GET(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ fonts: await workerFonts() })
}
