import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { listTasks, viewerFor, TASK_STATUSES, type TaskStatus, type Readiness } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'

const READINESS_VALUES: Readiness[] = ['AUTO', 'LOW', 'MANUAL']
const OPEN_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER']

function startOfTodayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()

  const sp = req.nextUrl.searchParams
  const statusesParam = sp.get('statuses')
  const rawStatuses = statusesParam ? statusesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const invalidStatuses = rawStatuses.filter(s => !TASK_STATUSES.includes(s as TaskStatus))
  if (invalidStatuses.length > 0) {
    return NextResponse.json({ error: `Unknown status: ${invalidStatuses.join(', ')}` }, { status: 400 })
  }
  const statuses = rawStatuses.length > 0 ? (rawStatuses as TaskStatus[]) : undefined
  const readinessParam = sp.get('readiness')
  const readiness = readinessParam && READINESS_VALUES.includes(readinessParam as Readiness) ? (readinessParam as Readiness) : undefined
  const q = sp.get('q')?.trim() || undefined
  const assigneeId = sp.get('mine') === '1' ? user.id : undefined

  let tasks
  if (statuses) {
    tasks = await listTasks({ statuses, readiness, assigneeId, q })
  } else {
    const matching = await prisma.designTask.findMany({
      where: {
        OR: [
          { status: { in: OPEN_STATUSES } },
          { status: 'DONE', updatedAt: { gte: startOfTodayUtc() } },
        ],
        ...(readiness ? { readiness } : {}),
        ...(assigneeId ? { assigneeId } : {}),
      },
      select: { taskKey: true },
    })
    tasks = await listTasks({ taskKeys: matching.map(m => m.taskKey), q })
  }

  return NextResponse.json({ tasks, me: viewerFor(user, await getDesignSettings()) })
}
