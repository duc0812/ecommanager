import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { syncToadditCatalog, toadditCatalog } from '@/lib/repos/toaddit-push'
import { toadditErrorResponse } from '@/lib/toaddit-http'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try { return NextResponse.json(await toadditCatalog()) }
  catch (e) { return toadditErrorResponse(e) }
}
export async function POST(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  try { return NextResponse.json(await syncToadditCatalog()) }
  catch (e) { return toadditErrorResponse(e) }
}
