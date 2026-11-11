import { NextRequest, NextResponse } from 'next/server'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { CoverageError } from '@/lib/artwork-library-coverage'
import { getLibraryCoverage, publishLibraryCoverage } from '@/lib/repos/artwork-library-coverage'

function error(e: unknown) {
  if (e instanceof CoverageError) return NextResponse.json({ error: e.message }, { status: e.status })
  throw e
}
export async function GET(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await getLibraryCoverage({ storeId: req.nextUrl.searchParams.get('storeId'), shopifyProductId: req.nextUrl.searchParams.get('shopifyProductId') }))
  } catch (e) { return error(e) }
}
export async function POST(req: NextRequest) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > 512 * 1024) return NextResponse.json({ error: 'Coverage payload quá lớn' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'JSON không hợp lệ' }, { status: 400 }) }
  try { return NextResponse.json(await publishLibraryCoverage(body)) }
  catch (e) { return error(e) }
}
