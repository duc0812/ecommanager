import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/api-auth'
import { defaultDeps } from '@/lib/cs/agent'
import { addDirective } from '@/lib/cs/directives'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const text = String(body.body ?? '').trim()
  if (!text) return NextResponse.json({ error: 'Nội dung chỉ đạo trống' }, { status: 400 })
  const ticket = await prisma.csTicket.findUnique({ where: { id: params.id } })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const deps = await defaultDeps()
  const result = await addDirective(ticket.id, text, { id: auth.user.id, name: auth.user.name }, { fd: deps?.fd ?? null, fdWrite: deps?.fd ?? null, llm: deps?.llm ?? null, appUrl: deps?.appUrl })
  return NextResponse.json(result)
}
