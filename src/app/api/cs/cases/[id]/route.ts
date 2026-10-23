import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, requireSuperadmin, unauthorized } from '@/lib/api-auth'
import { parseCaseBody } from '@/lib/cs/cases'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const parsed = parseCaseBody(body, true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const existing = await prisma.csCase.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Không tìm thấy case' }, { status: 404 })
  const updated = await prisma.csCase.update({ where: { id: params.id }, data: parsed.data as any })
  return NextResponse.json({ case: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const existing = await prisma.csCase.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Không tìm thấy case' }, { status: 404 })
  await prisma.csCase.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
