import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serveLibraryFile } from '@/lib/library-storage'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const row = await prisma.libraryFile.findUnique({ where: { id: params.id } })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const download = req.nextUrl.searchParams.get('download') === '1'
  if (row.kind === 'PSD') return serveLibraryFile(row, { disposition: 'attachment', redirectDrive: !download })
  if (row.kind === 'FONT') return serveLibraryFile(row, { disposition: 'attachment' })
  return serveLibraryFile(row, { disposition: download ? 'attachment' : 'inline' })
}
