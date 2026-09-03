import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { backfillProjectSnapshots } from '@/lib/cashflow-snapshot-scheduler'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const projectId = typeof body.projectId === 'string' ? body.projectId : null
  const ids = projectId
    ? [projectId]
    : (await prisma.project.findMany({ where: { archivedAt: null }, select: { id: true } })).map(p => p.id)
  const results: Record<string, any> = {}
  for (const id of ids) {
    try { results[id] = await backfillProjectSnapshots(id) }
    catch (e: any) { results[id] = { error: e.message } }
  }
  return NextResponse.json({ results })
}
