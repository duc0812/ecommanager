import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/api-auth'
import { refreshPush } from '@/lib/repos/pgprints-push'
import { pushErrorResponse } from '@/lib/pgprints-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireAdmin(req)
  if ('error' in auth) return auth.error
  try {
    return NextResponse.json(await refreshPush(params.orderId))
  } catch (e) {
    return pushErrorResponse(e)
  }
}
