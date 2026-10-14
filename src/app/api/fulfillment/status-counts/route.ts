import { NextRequest, NextResponse } from 'next/server'
import { countByStatus, countPartiallyExported, countWarnings } from '@/lib/repos/orders'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId') ?? undefined
  const [counts, warnings, partiallyExported] = await Promise.all([
    countByStatus({ projectId }),
    countWarnings({ projectId }),
    countPartiallyExported({ projectId }),
  ])
  // EXPORTED counts only fully sent orders; a partly sent one stays in READY_TO_PRODUCTION and is also counted here.
  return NextResponse.json({ ...counts, warnings, partiallyExported })
}
