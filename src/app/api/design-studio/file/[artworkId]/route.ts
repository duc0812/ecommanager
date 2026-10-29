import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { prisma } from '@/lib/db'
import { localArtworkPath } from '@/lib/design-storage'
import { DriveAuthError, DriveError, streamFile, streamThumbnail } from '@/lib/google-drive'

const DRIVE_WEB_PREFIX = 'https://drive.google.com/'

const NOT_WEB_IMAGES = ['image/vnd.adobe.photoshop', 'image/tiff']

/** Streams a file from disk instead of reading it whole: print files are often 10-100 MB and the box has 3.8 GB. */
async function diskResponse(absPath: string, headers: Record<string, string>): Promise<NextResponse | null> {
  let size: number
  try { size = (await fs.promises.stat(absPath)).size } catch { return null }
  const body = Readable.toWeb(fs.createReadStream(absPath)) as unknown as ReadableStream
  return new NextResponse(body, { headers: { ...headers, 'Content-Length': String(size) } })
}

async function serveThumbnail(row: { driveFileId: string | null; mimeType: string }) {
  if (!row.driveFileId || !row.mimeType.startsWith('image/')) return null
  try {
    const res = await streamThumbnail(row.driveFileId)
    if (!res) return null
    return new NextResponse(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return null
  }
}

function isPreviewable(mimeType: string) {
  return (mimeType.startsWith('image/') && !NOT_WEB_IMAGES.includes(mimeType)) || mimeType === 'application/pdf'
}

async function serveDrive(row: { fileName: string; mimeType: string; driveFileId: string | null; driveWebViewLink: string | null }) {
  if (!isPreviewable(row.mimeType)) {
    if (!row.driveWebViewLink?.startsWith(DRIVE_WEB_PREFIX)) return NextResponse.json({ error: 'Thiếu link Drive' }, { status: 404 })
    return NextResponse.redirect(row.driveWebViewLink, 302)
  }
  if (!row.driveFileId) return NextResponse.json({ error: 'Thiếu file Drive' }, { status: 404 })
  try {
    const res = await streamFile(row.driveFileId)
    const headers = {
      'Content-Type': row.mimeType,
      'Content-Disposition': `inline; filename="${row.fileName}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    }
    return new NextResponse(res.body, { headers })
  } catch (err: any) {
    if (err instanceof DriveAuthError) return NextResponse.json({ error: 'Google Drive cần kết nối lại' }, { status: 502 })
    if (err instanceof DriveError && err.status === 404) return NextResponse.json({ error: 'File không còn trên Drive' }, { status: 404 })
    return NextResponse.json({ error: err?.message ?? 'Lỗi Google Drive' }, { status: 502 })
  }
}

async function servePreview(row: { previewPath: string | null; fileName: string }) {
  const absPath = localArtworkPath(row.previewPath)
  if (!absPath) return null
  return diskResponse(absPath, {
    'Content-Type': 'image/jpeg',
    'Content-Disposition': `inline; filename="${row.fileName.replace(/\.[^.]+$/, '')}-preview.jpg"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  })
}

export async function GET(req: NextRequest, { params }: { params: { artworkId: string } }) {
  const { artworkId } = params
  const row = await prisma.designArtwork.findUnique({ where: { id: artworkId } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const wantsSmall = req.nextUrl.searchParams.get('preview') === '1' || req.nextUrl.searchParams.get('thumb') === '1'
  if (wantsSmall) {
    const preview = await servePreview(row)
    if (preview) return preview
    if (row.storage === 'DRIVE') {
      const thumb = await serveThumbnail(row)
      if (thumb) return thumb
    }
    // Never answer a request for a small picture with the original: on a 100 MB print that is minutes through this server.
    return NextResponse.json({ error: 'Chưa có bản xem nhỏ' }, { status: 404 })
  }
  if (row.storage === 'DRIVE') return serveDrive(row)

  const absPath = localArtworkPath(row.storagePath)
  if (!absPath) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const res = await diskResponse(absPath, {
    'Content-Type': row.mimeType,
    'Content-Disposition': `inline; filename="${row.fileName}"`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  })
  return res ?? NextResponse.json({ error: 'File missing on disk' }, { status: 404 })
}
