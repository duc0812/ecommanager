import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get('auth_token')?.value
  const user = token ? await verifyToken(token) : null
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.has(user.role)) return NextResponse.json({ error: 'Chỉ Admin mới được gán niche cho campaign.' }, { status: 403 })
  return null
}

export async function PUT(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const campaignId = String(b.campaignId ?? '').trim()
  const nicheId = String(b.nicheId ?? '').trim()
  if (!campaignId || !nicheId) return NextResponse.json({ error: 'campaignId and nicheId required' }, { status: 400 })
  const niche = await prisma.niche.findUnique({ where: { id: nicheId }, select: { id: true } })
  if (!niche) return NextResponse.json({ error: 'Niche not found' }, { status: 404 })
  const override = await prisma.metaCampaignNicheOverride.upsert({
    where: { campaignId },
    create: { campaignId, nicheId },
    update: { nicheId },
  })
  return NextResponse.json(override)
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req)
  if (denied) return denied
  const b = await req.json().catch(() => ({}))
  const campaignId = String(b.campaignId ?? '').trim()
  if (!campaignId) return NextResponse.json({ error: 'campaignId required' }, { status: 400 })
  await prisma.metaCampaignNicheOverride.deleteMany({ where: { campaignId } })
  return NextResponse.json({ ok: true })
}
