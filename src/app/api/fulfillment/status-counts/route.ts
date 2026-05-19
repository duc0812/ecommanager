import { NextRequest, NextResponse } from 'next/server'
import { countByStatus } from '@/lib/repos/orders'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId') ?? undefined
  const counts = await countByStatus({ projectId })
  return NextResponse.json(counts)
}
