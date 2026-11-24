import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { checkPrintpossConnection } from '@/lib/repos/printposs-push'
import { printpossErrorResponse } from '@/lib/printposs-http'

export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try { return NextResponse.json({ ok: true, ...(await checkPrintpossConnection()) }) }
  catch (e) { return printpossErrorResponse(e) }
}
