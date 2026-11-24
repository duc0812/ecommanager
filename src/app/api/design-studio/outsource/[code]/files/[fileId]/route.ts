import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { prisma } from '@/lib/db'
import { visibleOutsource, OutsourceError } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'
import { localArtworkPath, safeFileName } from '@/lib/design-storage'
import { streamFile, streamThumbnail } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'
export function GET(req: NextRequest, { params }: { params: { code: string; fileId: string } }) {
  return outsourceRoute(req, async user => {
    const a = await visibleOutsource(params.code, user)
    if (req.nextUrl.searchParams.has('r') && Number(req.nextUrl.searchParams.get('r')) !== a.revision) throw new OutsourceError('Không tìm thấy file', 404)
    const f = await prisma.designArtwork.findFirst({ where: { id: params.fileId, outsourceId: a.id, outsourceRevision: a.revision, removedAt: null } })
    if (!f) throw new OutsourceError('Không tìm thấy file', 404)
    const preview = req.nextUrl.searchParams.get('preview') === '1'
    const mime = preview ? 'image/jpeg' : f.mimeType
    const name = safeFileName(`${a.code}-${f.printArea}-v${f.version}${preview ? '.jpg' : '.' + f.fileName.split('.').pop()}`)
    const headers = { 'Content-Type': mime, 'Content-Disposition': `${!preview && req.nextUrl.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
    const local = localArtworkPath(preview ? f.previewPath : f.storagePath)
    if (local && await fs.promises.stat(local).then(s => s.isFile(), () => false)) return new NextResponse(Readable.toWeb(fs.createReadStream(local)) as ReadableStream, { headers })
    if (f.driveFileId) {
      try {
        const response = preview ? await streamThumbnail(f.driveFileId) : await streamFile(f.driveFileId)
        if (response) return new NextResponse(response.body, { headers: { ...headers, 'Content-Type': preview ? response.headers.get('content-type') ?? mime : mime } })
      } catch { throw new OutsourceError('Chưa tải được file, liên hệ nội bộ', 502) }
    }
    throw new OutsourceError('Chưa có bản xem trước hoặc file không còn khả dụng', 404)
  })
}
