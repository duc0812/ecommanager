import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { TooLargeError, discardTemp, streamToTempFile, type TempFile } from '@/lib/library-storage'
import { FONT_MAX_BYTES, FONT_MIME, LibraryError, saveFontUpload } from '@/lib/repos/artwork-library'

export async function PUT(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const fileName = req.nextUrl.searchParams.get('fileName')?.trim() ?? ''
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!fileName || !FONT_MIME[ext]) return NextResponse.json({ error: 'Chỉ nhận .ttf, .otf, .ttc' }, { status: 400 })
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > FONT_MAX_BYTES) return NextResponse.json({ error: 'Font lớn hơn 30 MB' }, { status: 413 })

  let temp: TempFile | null = null
  try {
    temp = await streamToTempFile(req.body, FONT_MAX_BYTES)
    return NextResponse.json(await saveFontUpload({ temp, fileName, uploadedById: auth.user.id }))
  } catch (err: any) {
    if (err instanceof TooLargeError) return NextResponse.json({ error: 'Font lớn hơn 30 MB' }, { status: 413 })
    if (err instanceof LibraryError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[artwork library] font upload failed:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Lỗi tải font' }, { status: 500 })
  } finally {
    await discardTemp(temp)
  }
}
