import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) return NextResponse.json({ error: 'Chỉ Admin mới được sửa niche.' }, { status: 403 })
  return null
}

function normKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(k => String(k).trim()).filter(Boolean)
  return String(v ?? '').split(/[\n,]/).map(k => k.trim()).filter(Boolean)
}

function isUniqueError(e: unknown) {
  return typeof e === 'object' && e !== null && (e as any).code === 'P2002'
}

function isNotFoundError(e: unknown) {
  return typeof e === 'object' && e !== null && (e as any).code === 'P2025'
}

export async function GET() {
  const niches = await prisma.niche.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  return NextResponse.json(niches)
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const name = String(b.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : await prisma.niche.count()
  try {
    const niche = await prisma.niche.create({ data: { name, keywords: JSON.stringify(normKeywords(b.keywords)), sortOrder } })
    return NextResponse.json(niche)
  } catch (e) {
    if (isUniqueError(e)) return NextResponse.json({ error: `Niche "${name}" đã tồn tại.` }, { status: 409 })
    throw e
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const data: Record<string, unknown> = {}
  if ('name' in b) {
    const name = String(b.name).trim()
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    data.name = name
  }
  if ('keywords' in b) data.keywords = JSON.stringify(normKeywords(b.keywords))
  if ('active' in b) data.active = Boolean(b.active)
  if ('sortOrder' in b && Number.isFinite(Number(b.sortOrder))) data.sortOrder = Number(b.sortOrder)
  try {
    const niche = await prisma.niche.update({ where: { id: String(b.id) }, data })
    return NextResponse.json(niche)
  } catch (e) {
    if (isUniqueError(e)) {
      const message = data.name === undefined ? 'Tên niche đã tồn tại.' : `Niche "${data.name}" đã tồn tại.`
      return NextResponse.json({ error: message }, { status: 409 })
    }
    if (isNotFoundError(e)) return NextResponse.json({ error: 'Niche not found' }, { status: 404 })
    throw e
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  if (!b.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    await prisma.niche.delete({ where: { id: String(b.id) } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (isNotFoundError(e)) return NextResponse.json({ error: 'Niche not found' }, { status: 404 })
    throw e
  }
}
