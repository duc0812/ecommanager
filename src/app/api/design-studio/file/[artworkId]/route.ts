import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import { readArtwork } from '@/lib/design-storage'

export async function GET(_req: NextRequest, { params }: { params: { artworkId: string } }) {
  const { artworkId } = params
  const art = await readArtwork(artworkId)
  if (!art) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let bytes: Buffer
  try { bytes = await fs.readFile(art.absPath) } catch { return NextResponse.json({ error: 'File missing on disk' }, { status: 404 }) }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': art.mimeType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${art.fileName}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
