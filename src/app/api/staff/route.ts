import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireFinanceScope, requireUnrestricted } from '@/lib/finance-scope'

// A seller gets the staff assigned to its projects, with those assignments only.
export async function GET(req: NextRequest) {
  const scope = await requireFinanceScope(req, 'projects')
  if ('error' in scope) return scope.error
  const inScope = scope.projectIds ? { projectId: { in: scope.projectIds } } : {}
  const staff = await prisma.staff.findMany({
    where: scope.projectIds ? { assignments: { some: inScope } } : {},
    orderBy: { createdAt: 'asc' },
    include: {
      assignments: {
        where: inScope,
        include: { project: true },
        orderBy: { startDate: 'asc' },
      },
    },
  })
  return NextResponse.json(staff)
}

export async function POST(req: NextRequest) {
  const auth = await requireUnrestricted(req)
  if ('error' in auth) return auth.error
  const body = await req.json()
  const { name, role, monthlyCost, note } = body
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const staff = await prisma.staff.create({
    data: { name, role: role || null, monthlyCost: monthlyCost ? parseFloat(monthlyCost) : 0, note: note || null },
  })
  return NextResponse.json(staff)
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUnrestricted(req)
  if ('error' in auth) return auth.error
  const { id } = await req.json()
  await prisma.staffAssignment.deleteMany({ where: { staffId: id } })
  await prisma.staff.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
