import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { LibraryError } from '@/lib/repos/artwork-library'
import { reportNasScan } from '@/lib/repos/artwork-nas'

export async function POST(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  try {
    return NextResponse.json(await reportNasScan(body))
  } catch (e) {
    if (e instanceof LibraryError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
