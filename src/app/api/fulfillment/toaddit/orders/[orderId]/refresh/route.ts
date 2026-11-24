import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { requireOrderScope } from '@/lib/order-scope'
import { refreshToadditPush } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function POST(req: NextRequest, { params }: { params: { orderId: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const scope = await requireOrderScope(req, params.orderId)
  if ('error' in scope) return scope.error
  try { return NextResponse.json(await refreshToadditPush(params.orderId)) }
  catch (e) { return toadditErrorResponse(e) }
}
