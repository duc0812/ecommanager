import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const staff = await prisma.staff.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      assignments: {
        include: { project: true },
        orderBy: { startDate: 'asc' },
      },
    },
  })
  return NextResponse.json(staff)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, role, monthlyCost, note } = body
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const staff = await prisma.staff.create({
    data: { name, role: role || null, monthlyCost: monthlyCost ? parseFloat(monthlyCost) : 0, note: note || null },
  })
  return NextResponse.json(staff)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  await prisma.staffAssignment.deleteMany({ where: { staffId: id } })
  await prisma.staff.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
