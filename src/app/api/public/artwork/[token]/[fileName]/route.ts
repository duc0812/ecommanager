import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { localArtworkPath } from '@/lib/design-storage'
import { DriveError, streamFile } from '@/lib/google-drive'
import { findPublicArtwork } from '@/lib/public-artwork'

export const dynamic = 'force-dynamic'

const BASE_HEADERS = { 'Cache-Control': 'private, max-age=0', 'X-Content-Type-Options': 'nosniff' }
const DRIVE_RETRY_MS = [300, 1000]

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: BASE_HEADERS })
}

/** A supplier opens this link once and reports it dead, so a passing Drive failure is retried and never looks like a missing file. */
async function openDriveFile(id: string): Promise<Response | 'missing' | 'unavailable'> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamFile(id)
    } catch (e: any) {
      if (e instanceof DriveError && e.status === 404) return 'missing'
      if (attempt >= DRIVE_RETRY_MS.length) {
        console.error('[public-artwork] Drive read failed', e?.status ?? '', e?.message ?? e)
        return 'unavailable'
      }
      await new Promise(resolve => setTimeout(resolve, DRIVE_RETRY_MS[attempt]))
    }
  }
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
    const res = await openDriveFile(art.driveFileId)
    if (res === 'missing') return notFound()
    if (res === 'unavailable') {
      return NextResponse.json({ error: 'File is temporarily unavailable' }, { status: 503, headers: { ...BASE_HEADERS, 'Retry-After': '30' } })
    }
    const length = res.headers.get('content-length')
    if (length && !res.headers.get('content-encoding')) headers['Content-Length'] = length
    return new NextResponse(res.body, { headers })
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
