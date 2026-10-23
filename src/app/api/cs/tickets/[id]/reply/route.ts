import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { defaultDeps } from '@/lib/cs/agent'
import { sendStaffReply } from '@/lib/cs/actions'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const text = String(body.body ?? '').trim()
  const isPrivate = body.private === true
  if (!text) return NextResponse.json({ error: 'Nội dung trống' }, { status: 400 })
  const ticket = await prisma.csTicket.findUnique({ where: { id: params.id } })
  if (!ticket) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  const deps = await defaultDeps()
  if (!deps) return NextResponse.json({ error: 'Chưa cấu hình Freshdesk API key' }, { status: 400 })
  try {
    const message = await sendStaffReply(deps.fd, ticket, text, { private: isPrivate })
    return NextResponse.json({ message })
  } catch (err: any) {
    return NextResponse.json({ error: `Freshdesk: ${err?.message ?? err}` }, { status: 502 })
  }
}
