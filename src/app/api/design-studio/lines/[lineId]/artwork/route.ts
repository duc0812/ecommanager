import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { loadArtworkRow, saveArtwork } from '@/lib/design-storage'
import { pushArtworkToDrive } from '@/lib/design-drive-push'

const MAX_BYTES = 200 * 1024 * 1024

export async function POST(req: NextRequest, { params }: { params: { lineId: string } }) {
  const { lineId } = params
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return NextResponse.json({ error: 'File lớn hơn 200 MB' }, { status: 413 })
  }
  const user = await getAuthUser(req)
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  const printArea = String(form?.get('printArea') ?? '')
  if (!file || typeof (file as any)?.arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  const upload = file as File
  if (upload.size > MAX_BYTES) return NextResponse.json({ error: 'File lớn hơn 200 MB' }, { status: 400 })
  let saved
  try {
    saved = await saveArtwork({
      lineId, printArea, fileName: upload.name, mimeType: upload.type || 'application/octet-stream',
      bytes: Buffer.from(await upload.arrayBuffer()), uploadedById: user?.id ?? null,
    })
  } catch (e: any) {
    const status = /not found/i.test(e.message) ? 404 : 400
    return NextResponse.json({ error: e.message }, { status })
  }
  const push = await pushArtworkToDrive(saved.id)
  const artwork = (await loadArtworkRow(saved.id)) ?? saved
  return NextResponse.json(push.warning ? { artwork, warning: push.warning } : { artwork })
}
