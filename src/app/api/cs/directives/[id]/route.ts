import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { resolveDirective } from '@/lib/cs/directives'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const existing = await prisma.csDirective.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Không tìm thấy chỉ đạo' }, { status: 404 })
  const directive = await resolveDirective(params.id, { id: user.id }, body.resolved !== false)
  return NextResponse.json({ directive })
}
