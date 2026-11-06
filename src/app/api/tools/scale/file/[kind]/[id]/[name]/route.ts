import { NextRequest, NextResponse } from 'next/server'
import { readScaleFile, resolveScaleFile } from '@/lib/scale/storage'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { kind: string; id: string; name: string } }) {
  const file = resolveScaleFile(params.kind, params.id, params.name) ? await readScaleFile(params.kind as 'targets' | 'jobs' | 'views', params.id, params.name) : null
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return new NextResponse(file.bytes as unknown as BodyInit, {
    headers: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes.length), 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' },
  })
}
