import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyWorkerRequest } from '@/lib/artwork-worker'
import { serveLibraryFile } from '@/lib/library-storage'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await verifyWorkerRequest(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const row = await prisma.libraryFile.findUnique({ where: { id: params.id } })
  if (!row || !['PSD', 'FONT', 'ARTWORK'].includes(row.kind)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const res = await serveLibraryFile(row, { disposition: 'attachment' })
  if (res.ok) res.headers.set('X-Content-SHA256', row.sha256)
  return res
}
