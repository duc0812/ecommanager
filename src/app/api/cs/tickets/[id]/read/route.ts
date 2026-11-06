import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { markRead } from '@/lib/cs/tasks'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (!(await prisma.csTicket.findUnique({ where: { id: params.id }, select: { id: true } }))) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  await markRead(params.id, { id: user.id, name: user.name })
  return NextResponse.json({ ok: true })
}
