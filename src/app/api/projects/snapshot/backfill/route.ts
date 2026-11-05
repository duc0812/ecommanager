import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { forbidden } from '@/lib/api-auth'
import { backfillProjectSnapshots } from '@/lib/cashflow-snapshot-scheduler'
import { ownsProject, projectWhere, requireFinanceScope } from '@/lib/finance-scope'

export async function POST(req: NextRequest) {
  const scope = await requireFinanceScope(req, 'projects')
  if ('error' in scope) return scope.error
  const body = await req.json().catch(() => ({}))
  const projectId = typeof body.projectId === 'string' ? body.projectId : null
  if (projectId && !ownsProject(scope, projectId)) return forbidden('Bạn không có quyền xem project này.')
  const ids = projectId
    ? [projectId]
    : (await prisma.project.findMany({ where: { archivedAt: null, ...projectWhere(scope) }, select: { id: true } })).map(p => p.id)
  const results: Record<string, any> = {}
  for (const id of ids) {
    try { results[id] = await backfillProjectSnapshots(id) }
    catch (e: any) { results[id] = { error: e.message } }
  }
  return NextResponse.json({ results })
}
