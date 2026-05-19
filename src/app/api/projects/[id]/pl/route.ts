import { NextRequest, NextResponse } from 'next/server'
import { combinedProjectPL } from '@/lib/repos/reports'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { searchParams } = new URL(req.url)
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  try {
    const pl = await combinedProjectPL({
      projectId: params.id,
      dateFrom: dateFrom ? new Date(dateFrom + 'T00:00:00Z') : undefined,
      dateTo: dateTo ? new Date(dateTo + 'T23:59:59.999Z') : undefined,
    })
    return NextResponse.json(pl)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
