import { NextRequest, NextResponse } from 'next/server'
import { JOB_NOT_FOUND } from '@/lib/clone/jobs'
import { failCloneJob, verifyCloneWorkerRequest } from '@/lib/clone/worker'
import { badRequest, isJsonObject, positiveInt, readJson } from '@/lib/clone/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyCloneWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await readJson(req)
  if (!isJsonObject(body)) return badRequest()
  const attempts = positiveInt(body.attempts)
  if (attempts === null) return badRequest()
  const failed = await failCloneJob(params.id, attempts, {
    failKind: body.failKind,
    error: body.error,
    productGid: body.productGid,
    retryable: body.retryable,
  })
  if (!failed) return NextResponse.json({ error: JOB_NOT_FOUND }, { status: 404 })
  return NextResponse.json(failed)
}
