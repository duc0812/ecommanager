import { NextRequest, NextResponse } from 'next/server'
import { ticketDetail } from '@/lib/cs/queries'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const detail = await ticketDetail(params.id)
  if (!detail) return NextResponse.json({ error: 'Không tìm thấy ticket' }, { status: 404 })
  return NextResponse.json(detail)
}
