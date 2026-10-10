import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { localArtworkPath } from '@/lib/design-storage'
import { streamFile } from '@/lib/google-drive'
import { findPublicArtwork } from '@/lib/public-artwork'

export const dynamic = 'force-dynamic'

const BASE_HEADERS = { 'Cache-Control': 'private, max-age=0', 'X-Content-Type-Options': 'nosniff' }

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: BASE_HEADERS })
}

export async function GET(_req: NextRequest, { params }: { params: { token: string; fileName: string } }) {
  const art = await findPublicArtwork(params.token, params.fileName)
  if (!art) return notFound()
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Content-Type': art.mimeType,
    'Content-Disposition': `inline; filename="${art.fileName}"`,
  }

  if (art.storage === 'DRIVE') {
    if (!art.driveFileId) return notFound()
    try {
      const res = await streamFile(art.driveFileId)
      return new NextResponse(res.body, { headers })
    } catch {
      return notFound()
    }
  }

  const absPath = localArtworkPath(art.storagePath)
  if (!absPath) return notFound()
  let size: number
  try {
    const stat = await fs.promises.stat(absPath)
    if (!stat.isFile()) return notFound()
    size = stat.size
  } catch {
    return notFound()
  }
  const body = Readable.toWeb(fs.createReadStream(absPath)) as unknown as BodyInit
  return new NextResponse(body, { headers: { ...headers, 'Content-Length': String(size) } })
}
