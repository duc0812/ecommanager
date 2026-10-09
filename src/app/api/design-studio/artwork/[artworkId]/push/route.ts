import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { loadArtworkRow, localArtworkPath } from '@/lib/design-storage'
import { pushArtworkToDrive } from '@/lib/design-drive-push'
import { isDriveConnected } from '@/lib/google-drive'

export async function POST(_req: NextRequest, { params }: { params: { artworkId: string } }) {
  const { artworkId } = params
  const row = await prisma.designArtwork.findUnique({ where: { id: artworkId }, select: { storage: true, storagePath: true } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (row.storage === 'DRIVE') return NextResponse.json({ error: 'File đã ở trên Drive' }, { status: 400 })
  const absPath = localArtworkPath(row.storagePath)
  const exists = absPath ? await fs.stat(absPath).then(s => s.isFile(), () => false) : false
  if (!exists) return NextResponse.json({ error: 'File local không còn trên server' }, { status: 400 })
  if (!(await isDriveConnected())) return NextResponse.json({ error: 'Google Drive chưa được kết nối' }, { status: 400 })

  const push = await pushArtworkToDrive(artworkId)
  if (!push.pushed) return NextResponse.json({ error: push.warning ?? 'Chưa đẩy được lên Drive' }, { status: 502 })
  return NextResponse.json({ artwork: await loadArtworkRow(artworkId) })
}
