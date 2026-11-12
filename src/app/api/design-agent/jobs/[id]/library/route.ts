import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireTaskScope } from '@/lib/order-scope'
import { decideLibrary } from '@/lib/design-agent/jobs'
import { agentErrorResponse, readBody } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const job = await prisma.designAgentJob.findUnique({ where: { id: params.id }, select: { taskKey: true } })
    if (!job || !job.taskKey) return NextResponse.json({ error: 'Không tìm thấy job' }, { status: 404 })
    const scope = await requireTaskScope(req, job.taskKey)
    if ('error' in scope) return scope.error
    const body = await readBody(req)
    if (typeof body.save !== 'boolean') return NextResponse.json({ error: 'save phải là true hoặc false' }, { status: 400 })
    return NextResponse.json(await decideLibrary(params.id, body.save, { id: scope.user.id, name: scope.user.name }))
  } catch (e) {
    return agentErrorResponse(e)
  }
}
