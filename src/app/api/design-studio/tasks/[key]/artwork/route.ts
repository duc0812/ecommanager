import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { ARTWORK_TYPES_LABEL, MAX_ARTWORK_BYTES, artworkFileType, artworkTargetForTask, saveArtworkFromTemp } from '@/lib/design-storage'
import { requiredSlotsForLine, retireOutdatedParts } from '@/lib/design-tasks'
import { TooLargeError, discardTemp, streamToTempFile, type TempFile } from '@/lib/library-storage'
import { enqueueDrivePush } from '@/lib/drive-push-queue'
import { fileKindOf, isFileKind } from '@/lib/task-files'

const TOO_LARGE = 'File lớn hơn 200 MB'
const MOCKUP_MIME = ['image/png', 'image/jpeg']
const MAX_PART_PARAM = 200

/**
 * One file of a task. `kind` is PRINT (default) or MOCKUP. `printArea` names the part the file belongs to (a template area,
 * or the part being replaced); without it the part is read from the file name, so `front.png` + `back.png` are two files
 * and a second `front.png` is version 2 of "front".
 */
export async function PUT(req: NextRequest, { params }: { params: { key: string } }) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error

  const sp = req.nextUrl.searchParams
  const printArea = sp.get('printArea')?.trim() ?? ''
  const fileName = sp.get('fileName')?.trim() ?? ''
  const kindParam = sp.get('kind')
  if (kindParam && !isFileKind(kindParam)) return NextResponse.json({ error: 'kind phải là PRINT hoặc MOCKUP' }, { status: 400 })
  const kind = fileKindOf(kindParam)
  if (!fileName) return NextResponse.json({ error: 'Thiếu fileName' }, { status: 400 })
  if (printArea.length > MAX_PART_PARAM) return NextResponse.json({ error: 'Tên phần file quá dài' }, { status: 400 })
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const type = artworkFileType(fileName, contentType)
  if (!type) {
    return NextResponse.json({ error: `Không nhận loại file này: ${fileName}. Chỉ nhận ${ARTWORK_TYPES_LABEL}.` }, { status: 400 })
  }
  if (kind === 'MOCKUP' && !MOCKUP_MIME.includes(type.mimeType)) {
    return NextResponse.json({ error: `Mockup chỉ nhận ảnh PNG hoặc JPG: ${fileName}` }, { status: 400 })
  }
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ARTWORK_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })

  const target = await artworkTargetForTask(params.key)
  if (target === 'no-task') return NextResponse.json({ error: 'Không tìm thấy task' }, { status: 404 })
  if (target === 'no-line') return NextResponse.json({ error: 'Dòng đơn của task đang được đồng bộ lại — thử lại sau vài giây' }, { status: 409 })

  let temp: TempFile | null = null
  try {
    const derivePart = printArea ? undefined : { slots: kind === 'PRINT' ? await requiredSlotsForLine(target.orderId, target.shopifyLineId) : [] }
    temp = await streamToTempFile(req.body, MAX_ARTWORK_BYTES)
    if (temp.size === 0) return NextResponse.json({ error: 'File rỗng' }, { status: 400 })
    const artwork = await saveArtworkFromTemp({ target, kind, printArea, derivePart, fileName, mimeType: contentType, temp, uploadedById: auth.user.id })
    if (kind === 'PRINT') await retireOutdatedParts(target.orderId, target.shopifyLineId, auth.user.id)
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
