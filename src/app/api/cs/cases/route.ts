import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAuthUser, unauthorized } from '@/lib/api-auth'
import { CS_CATEGORIES } from '@/lib/cs/triage'

export const dynamic = 'force-dynamic'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export function parseCaseBody(body: any, partial = false): { data: Record<string, unknown> } | { error: string } {
  const data: Record<string, unknown> = {}
  const fields = ['title', 'category', 'situation', 'resolution'] as const
  for (const f of fields) {
    if (body[f] !== undefined || !partial) {
      const v = str(body[f])
      if (!v) return { error: `Thiếu ${f}` }
      data[f] = v
    }
  }
  if (data.category !== undefined && !(CS_CATEGORIES as readonly string[]).includes(data.category as string)) return { error: 'Category không hợp lệ' }
  for (const f of ['toneNotes', 'forbidden', 'exampleReply'] as const) {
    if (body[f] !== undefined) data[f] = str(body[f]) || null
  }
  if (typeof body.active === 'boolean') data.active = body.active
  return { data }
}

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
