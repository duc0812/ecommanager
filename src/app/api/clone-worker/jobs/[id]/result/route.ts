import { NextRequest, NextResponse } from 'next/server'
import { JOB_NOT_FOUND } from '@/lib/clone/jobs'
import { completeCloneJob, verifyCloneWorkerRequest } from '@/lib/clone/worker'
import { badRequest, isJsonObject, positiveInt, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyCloneWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await readJson(req)
  if (!isJsonObject(body)) return badRequest()
  const attempts = positiveInt(body.attempts)
  if (attempts === null) return badRequest()
  const done = await completeCloneJob(params.id, attempts, {
    productGid: body.productGid,
    handle: body.handle,
    qaVerdict: body.qaVerdict,
    qaNote: body.qaNote,
    reused: body.reused,
    costUsd: body.costUsd,
    durationMs: body.durationMs,
  })
  if (!done) return NextResponse.json({ error: JOB_NOT_FOUND }, { status: 404 })
  if ('retry' in done) return NextResponse.json({ error: done.error }, { status: 502 })
  return NextResponse.json(done)
}
