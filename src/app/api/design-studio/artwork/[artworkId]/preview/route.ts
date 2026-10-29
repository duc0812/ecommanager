import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/api-auth'
import { MAX_PREVIEW_BYTES, PreviewError, setArtworkPreview } from '@/lib/design-storage'

/** A small JPEG the browser made of a file it just uploaded, so nobody has to pull the original to see it. */
export async function PUT(req: NextRequest, { params }: { params: { artworkId: string } }) {
  const user = await getAuthUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) return NextResponse.json({ error: 'Preview quá lớn' }, { status: 413 })
  try {
    const bytes = Buffer.from(await req.arrayBuffer())
    const r = await setArtworkPreview(params.artworkId, bytes)
    return NextResponse.json(r)
  } catch (e: any) {
    if (e instanceof PreviewError) return NextResponse.json({ error: e.message }, { status: e.status })
    return NextResponse.json({ error: e?.message ?? 'Lỗi lưu preview' }, { status: 500 })
  }
}
