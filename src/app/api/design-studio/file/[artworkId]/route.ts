import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { localArtworkPath } from '@/lib/design-storage'
import { DriveAuthError, DriveError, streamFile } from '@/lib/google-drive'

const DRIVE_WEB_PREFIX = 'https://drive.google.com/'

const NOT_WEB_IMAGES = ['image/vnd.adobe.photoshop', 'image/tiff']

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
  let bytes: Buffer
  try { bytes = await fs.readFile(absPath) } catch { return null }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${row.fileName.replace(/\.[^.]+$/, '')}-preview.jpg"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function GET(req: NextRequest, { params }: { params: { artworkId: string } }) {
  const { artworkId } = params
  const row = await prisma.designArtwork.findUnique({ where: { id: artworkId } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (req.nextUrl.searchParams.get('preview') === '1') {
    const preview = await servePreview(row)
    if (preview) return preview
  }
  if (row.storage === 'DRIVE') return serveDrive(row)

  const absPath = localArtworkPath(row.storagePath)
  if (!absPath) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let bytes: Buffer
  try { bytes = await fs.readFile(absPath) } catch { return NextResponse.json({ error: 'File missing on disk' }, { status: 404 }) }
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': row.mimeType,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${row.fileName}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
