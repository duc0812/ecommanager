import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireUnrestricted } from '@/lib/finance-scope'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUnrestricted(req)
  if ('error' in auth) return auth.error
  await prisma.otherBill.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
