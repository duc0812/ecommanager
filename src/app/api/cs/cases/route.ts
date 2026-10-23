import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { parseCaseBody } from '@/lib/cs/cases'

export const dynamic = 'force-dynamic'

export async function GET() {
  const cases = await prisma.csCase.findMany({ orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }] })
  return NextResponse.json({ cases })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) return unauthorized()
  const body = await req.json().catch(() => ({}))
  const parsed = parseCaseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const created = await prisma.csCase.create({ data: { ...(parsed.data as any), createdById: user.id, source: 'MANUAL' } })
  return NextResponse.json({ case: created })
}
