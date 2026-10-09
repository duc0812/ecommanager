import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { LibraryError } from '@/lib/repos/artwork-library'
import { latestRenderJob, queueRenderLine } from '@/lib/repos/artwork-render'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const task = await prisma.designTask.findUnique({ where: { taskKey: params.key }, select: { orderId: true, shopifyLineId: true } })
  if (!task) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  return NextResponse.json({ job: await latestRenderJob(task.orderId, task.shopifyLineId) })
}

export async function POST(req: NextRequest, { params }: { params: { key: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  try {
    return NextResponse.json({ job: await queueRenderLine(params.key, user) })
  } catch (err: any) {
    if (err instanceof LibraryError) return NextResponse.json({ error: err.message }, { status: err.status })
    throw err
  }
}
