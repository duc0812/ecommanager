import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { checkToadditConnection } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try { return NextResponse.json({ ok: true, ...(await checkToadditConnection()) }) }
  catch (e) { return toadditErrorResponse(e) }
}
