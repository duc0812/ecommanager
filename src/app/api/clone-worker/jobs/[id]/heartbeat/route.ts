import { NextRequest, NextResponse } from 'next/server'
import { heartbeatCloneJob, verifyCloneWorkerRequest } from '@/lib/clone/worker'
import { badRequest, isJsonObject, positiveInt, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyCloneWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await readJson(req)
  if (!isJsonObject(body)) return badRequest()
  const attempts = positiveInt(body.attempts)
  if (attempts === null) return badRequest()
  return NextResponse.json(await heartbeatCloneJob(params.id, attempts, { stage: body.stage, platform: body.platform }))
}
