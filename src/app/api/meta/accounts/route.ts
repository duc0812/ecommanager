import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const accounts = await prisma.metaAdAccount.findMany({
    orderBy: { createdAt: 'asc' },
    include: { project: true },
  })
  return NextResponse.json(accounts)
}

export async function POST(req: NextRequest) {
  const { accountId, accountName, accessToken, projectId } = await req.json()
  if (!accountId || !accessToken) {
    return NextResponse.json({ error: 'accountId and accessToken required' }, { status: 400 })
  }
  const clean = accountId.trim().startsWith('act_') ? accountId.trim() : `act_${accountId.trim()}`
  const account = await prisma.metaAdAccount.upsert({
    where: { accountId: clean },
    create: { accountId: clean, accountName: accountName || null, accessToken, projectId: projectId || null },
    update: { accountName: accountName || null, accessToken, projectId: projectId || null },
    include: { project: true },
  })
  return NextResponse.json(account)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  await prisma.metaBilling.deleteMany({ where: { adAccountId: id } })
  await prisma.metaAdAccount.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const { id, projectId } = await req.json()
  const account = await prisma.metaAdAccount.update({
    where: { id },
    data: { projectId: projectId || null },
    include: { project: true },
  })
  return NextResponse.json(account)
}
