import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { ARTWORK_TYPES_LABEL, MAX_ARTWORK_BYTES, artworkFileType, artworkTargetForTask, saveArtworkFromTemp } from '@/lib/design-storage'
import { TooLargeError, discardTemp, streamToTempFile, type TempFile } from '@/lib/library-storage'
import { enqueueDrivePush } from '@/lib/drive-push-queue'

const TOO_LARGE = 'File lớn hơn 200 MB'

export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error

  const sp = req.nextUrl.searchParams
  const printArea = sp.get('printArea')?.trim() ?? ''
  const fileName = sp.get('fileName')?.trim() ?? ''
  if (!fileName) return NextResponse.json({ error: 'Thiếu fileName' }, { status: 400 })
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!artworkFileType(fileName, contentType)) {
    return NextResponse.json({ error: `Không nhận loại file này: ${fileName}. Chỉ nhận ${ARTWORK_TYPES_LABEL}.` }, { status: 400 })
  }
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ARTWORK_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })

  const target = await artworkTargetForTask(params.key)
  if (target === 'no-task') return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  if (target === 'no-line') return NextResponse.json({ error: 'Dòng đơn của task đang được đồng bộ lại — thử lại sau vài giây' }, { status: 409 })

  let temp: TempFile | null = null
  try {
    temp = await streamToTempFile(req.body, MAX_ARTWORK_BYTES)
    if (temp.size === 0) return NextResponse.json({ error: 'File rỗng' }, { status: 400 })
    const artwork = await saveArtworkFromTemp({ target, printArea, fileName, mimeType: contentType, temp, uploadedById: auth.user.id })
    enqueueDrivePush(artwork.id)
    return NextResponse.json({ artwork })
  } catch (err: any) {
    if (err instanceof TooLargeError) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })
    console.error('[design artwork] upload failed:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Lỗi tải lên' }, { status: 500 })
  } finally {
    await discardTemp(temp)
  }
}
