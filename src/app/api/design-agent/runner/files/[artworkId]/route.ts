import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import { Readable } from 'stream'
import { prisma } from '@/lib/db'
import { localArtworkPath } from '@/lib/design-storage'
import { DriveAuthError, DriveError, streamFile } from '@/lib/google-drive'
import { runningJobCovering } from '@/lib/design-agent/delivery'
import { agentErrorResponse, requireRunner } from '@/lib/design-agent/route-http'

export const dynamic = 'force-dynamic'

const NOT_FOUND = 'Not found'

function attachment(fileName: string): string {
  return `attachment; filename="${fileName.replace(/[^\w. -]/g, '_')}"`
}

export async function GET(req: NextRequest, { params }: { params: { artworkId: string } }) {
  const denied = await requireRunner(req)
  if (denied) return denied
  try {
    const row = await prisma.designArtwork.findUnique({ where: { id: params.artworkId } })
    const task = row ? await prisma.designTask.findFirst({ where: { orderId: row.orderId, shopifyLineId: row.shopifyLineId }, select: { taskKey: true } }) : null
    if (!row || !task || !(await runningJobCovering(task.taskKey))) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })
    const headers = {
      'Content-Type': row.mimeType, 'Content-Disposition': attachment(row.fileName), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    }
    if (row.storage === 'DRIVE') {
      if (!row.driveFileId) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })
      try {
        const res = await streamFile(row.driveFileId)
        return new NextResponse(res.body, { headers })
      } catch (err) {
        if (err instanceof DriveAuthError) return NextResponse.json({ error: 'Google Drive cần kết nối lại' }, { status: 502 })
        if (err instanceof DriveError && err.status === 404) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })
        throw err
      }
    }
    const absPath = localArtworkPath(row.storagePath)
    if (!absPath) return NextResponse.json({ error: NOT_FOUND }, { status: 404 })
    let size: number
    try { size = (await fs.promises.stat(absPath)).size } catch { return NextResponse.json({ error: NOT_FOUND }, { status: 404 }) }
    const body = Readable.toWeb(fs.createReadStream(absPath)) as unknown as ReadableStream
    return new NextResponse(body, { headers: { ...headers, 'Content-Length': String(size) } })
  } catch (e) {
    return agentErrorResponse(e)
  }
}
