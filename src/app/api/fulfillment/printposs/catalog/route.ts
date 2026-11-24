import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { syncPrintpossCatalog } from '@/lib/repos/printposs-push'
import { printpossErrorResponse } from '@/lib/printposs-http'

export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try { return NextResponse.json(await syncPrintpossCatalog()) }
  catch (e) { return printpossErrorResponse(e) }
}
