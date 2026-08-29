import { NextRequest, NextResponse } from 'next/server'
import { listOrderTasks } from '@/lib/repos/order-tasks'

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') ?? undefined
  const data = await listOrderTasks({ projectId })
  return NextResponse.json(data)
}
