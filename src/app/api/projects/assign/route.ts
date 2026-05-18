import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { staffId, projectId, startDate, endDate } = body
  if (!staffId || !projectId || !startDate) {
    return NextResponse.json({ error: 'staffId, projectId, startDate required' }, { status: 400 })
  }
  const assignment = await prisma.staffAssignment.upsert({
    where: { staffId_projectId: { staffId, projectId } },
    create: { staffId, projectId, startDate: new Date(startDate), endDate: endDate ? new Date(endDate) : null },
    update: { startDate: new Date(startDate), endDate: endDate ? new Date(endDate) : null },
    include: { staff: true, project: true },
  })
  return NextResponse.json(assignment)
}

export async function DELETE(req: NextRequest) {
  const { staffId, projectId } = await req.json()
  await prisma.staffAssignment.delete({ where: { staffId_projectId: { staffId, projectId } } })
  return NextResponse.json({ ok: true })
}
