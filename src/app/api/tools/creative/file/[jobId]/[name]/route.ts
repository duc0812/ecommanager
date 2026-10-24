import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import { resolveFile } from '@/lib/creative/storage'

export const dynamic = 'force-dynamic'

const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export async function GET(_req: NextRequest, { params }: { params: { jobId: string; name: string } }) {
  const abs = resolveFile(params.jobId, params.name)
  if (!abs) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const mime = EXT_MIME[params.name.split('.').pop()!.toLowerCase()]
  let bytes: Buffer
  try { bytes = await fs.readFile(abs) } catch { return NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: { 'Content-Type': mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  })
}
