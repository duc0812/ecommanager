import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { listTasks, viewerFor, TASK_STATUSES, type TaskStatus, type Readiness } from '@/lib/design-tasks'
import { getDesignSettings } from '@/lib/design-settings'
import { countPendingHandoff } from '@/lib/supplier-handoff'
import { getLastDesignTaskSync } from '@/lib/design-task-sync'

const READINESS_VALUES: Readiness[] = ['AUTO', 'LOW', 'MANUAL']
const OPEN_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER']

function startOfTodayUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

const SEARCH_LIMIT = 200

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
  // "#LIT5199" and "LIT5199" find the same order
  const q = sp.get('q')?.trim().replace(/^#/, '') || undefined
  const assigneeId = sp.get('mine') === '1' ? user.id : undefined

  let tasks
  if (statuses) {
    tasks = await listTasks({ statuses, readiness, assigneeId, q })
  } else if (q) {
    // A search looks through every task, finished or cancelled too: the default queue hides DONE tasks
    // after the day they were approved, so an order already sent to the factory could not be found.
    // Narrowed in the database first, so a search never loads the whole task history.
    const matching = await prisma.designTask.findMany({
      where: {
        OR: [
          { taskKey: { contains: q } },
          { order: { lines: { some: { OR: [{ sku: { contains: q } }, { productTitle: { contains: q } }, { customAttributesJson: { contains: q } }] } } } },
        ],
        ...(readiness ? { readiness } : {}),
        ...(assigneeId ? { assigneeId } : {}),
      },
      select: { taskKey: true }, orderBy: { createdAt: 'desc' }, take: SEARCH_LIMIT,
    })
    tasks = await listTasks({ taskKeys: matching.map(m => m.taskKey), q })
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

  const [settings, handoffCount, lastSync] = await Promise.all([getDesignSettings(), countPendingHandoff(), getLastDesignTaskSync()])
  return NextResponse.json({ tasks, me: viewerFor(user, settings), handoffCount, lastSync })
}
