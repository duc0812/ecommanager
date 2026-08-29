import { NextRequest, NextResponse } from 'next/server'
import { countByStatus, countWarnings } from '@/lib/repos/orders'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId') ?? undefined
  const [counts, warnings] = await Promise.all([
    countByStatus({ projectId }),
    countWarnings({ projectId }),
  ])
  return NextResponse.json({ ...counts, warnings })
}
