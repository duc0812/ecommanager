import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { serveLibraryFile } from '@/lib/library-storage'
import { getAccessToken } from '@/lib/google-drive'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const row = await prisma.libraryFile.findUnique({ where: { id: params.id } })
  if (!row || !['PSD', 'FONT', 'ARTWORK'].includes(row.kind)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // The office PC reaches Google ~60x faster than this server, so a big Drive PSD is fetched directly with a short-lived
  // token (drive.file scope: only files this app created). The worker token already grants these same files.
  if (req.nextUrl.searchParams.get('direct') === '1' && row.storage === 'DRIVE' && row.driveFileId) {
    try {
      return NextResponse.json({
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.driveFileId)}?alt=media`,
        accessToken: await getAccessToken(), sha256: row.sha256, size: row.size,
      }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      // fall through to streaming through the server
    }
  }
  const res = await serveLibraryFile(row, { disposition: 'attachment' })
  if (res.ok) res.headers.set('X-Content-SHA256', row.sha256)
  return res
}
