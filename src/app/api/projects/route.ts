import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const projects = await prisma.project.findMany({
    orderBy: { startDate: 'desc' },
    include: {
      assignments: {
        include: { staff: true },
        orderBy: { startDate: 'asc' },
      },
      shopifyStore: { select: { shop: true } },
    },
  })
  return NextResponse.json(projects)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, startDate, description } = body
  if (!name || !startDate) {
    return NextResponse.json({ error: 'name and startDate required' }, { status: 400 })
  }
  const project = await prisma.project.create({
    data: { name, startDate: new Date(startDate), description },
  })
  return NextResponse.json(project)
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { id, name, startDate, description } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const data: { name?: string; startDate?: Date; description?: string } = {}
  if (typeof name === 'string' && name.trim()) data.name = name.trim()
  if (typeof description === 'string') data.description = description
  if (startDate) {
    const parsed = new Date(startDate)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: 'invalid startDate' }, { status: 400 })
    }
    data.startDate = parsed
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const project = await prisma.project.update({ where: { id }, data })
  return NextResponse.json(project)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  await prisma.staffAssignment.deleteMany({ where: { projectId: id } })
  await prisma.project.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
