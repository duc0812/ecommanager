import { NextRequest, NextResponse } from 'next/server'
import { claimWithWait, verifyCloneWorkerRequest } from '@/lib/clone/worker'
import { badRequest, isJsonObject, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

// Held open for up to 25 s on purpose: the runner asks once and waits for a job instead of polling.
export async function POST(req: NextRequest) {
  if (!(await verifyCloneWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await readJson(req)
  if (!isJsonObject(body)) return badRequest()
  return NextResponse.json(await claimWithWait(typeof body.waitSeconds === 'number' ? body.waitSeconds : 0, req.signal))
}
