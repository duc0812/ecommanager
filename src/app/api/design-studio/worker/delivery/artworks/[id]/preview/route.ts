import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireDeliveryWorker } from '@/lib/delivery/guard'
import { MAX_PREVIEW_BYTES, PreviewError, setArtworkPreview } from '@/lib/design-storage'

export const dynamic = 'force-dynamic'

const fail = (error: string, code: string, status: number) => NextResponse.json({ error, code }, { status })

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireDeliveryWorker(req)
  if (denied) return denied

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) return fail('Preview quá 4 MB', 'too_large', 413)
  const body = Buffer.from(await req.arrayBuffer())
  if (body.length > MAX_PREVIEW_BYTES) return fail('Preview quá 4 MB', 'too_large', 413)
  if (body.length < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return fail('Preview phải là JPEG', 'not_jpeg', 400)

  const row = await prisma.designArtwork.findUnique({ where: { id: params.id }, select: { removedAt: true, source: true } })
  if (!row) return fail('Không tìm thấy file', 'not_found', 404)
  if (row.removedAt || row.source !== 'AUTO') return fail('File không phải bản tự động', 'not_auto', 409)

  try {
    await setArtworkPreview(params.id, body)
  } catch (e) {
    if (e instanceof PreviewError) return fail(e.message, e.status === 404 ? 'not_found' : e.status === 400 ? 'not_jpeg' : 'preview_error', e.status)
    throw e
  }
  const saved = await prisma.designArtwork.findUnique({ where: { id: params.id }, select: { previewPath: true } })
  return NextResponse.json({ ok: true, previewPath: saved?.previewPath ?? null })
}
