import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperadmin } from '@/lib/api-auth'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  const proxyId = typeof body?.proxyId === 'string' ? body.proxyId : ''
  if (!proxyId) return NextResponse.json({ error: 'proxyId là bắt buộc.' }, { status: 400 })
  const proxy = await prisma.resourceProxy.findUnique({ where: { id: proxyId }, select: { password: true } })
  if (!proxy) return NextResponse.json({ error: 'Không tìm thấy proxy.' }, { status: 404 })
  return NextResponse.json({ password: proxy.password })
}
