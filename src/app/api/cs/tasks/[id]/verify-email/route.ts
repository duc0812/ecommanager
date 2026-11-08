import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { defaultDeps } from '@/lib/cs/agent'
import { getCsSettings } from '@/lib/cs/settings'
import { sendVerifyEmail, verifyEmailDraft } from '@/lib/cs/custom-verify'

export const dynamic = 'force-dynamic'

const missing = async (id: string) => !(await prisma.csTask.findUnique({ where: { id }, select: { id: true } }))

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  if (await missing(params.id)) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  try {
    return NextResponse.json(await verifyEmailDraft(params.id))
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Không soạn được email' }, { status: 400 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  if (await missing(params.id)) return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const deps = await defaultDeps()
  if (!deps) return NextResponse.json({ error: 'Chưa cấu hình Freshdesk API key' }, { status: 400 })
  try {
    const settings = await getCsSettings()
    return NextResponse.json(await sendVerifyEmail(params.id, { subject: String(body.subject ?? ''), body: String(body.body ?? '') }, { id: user.id, name: user.name }, { fd: deps.fd, emailConfigId: settings.outboundEmailConfigId }))
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? 'Không gửi được email' }, { status: 400 })
  }
}
