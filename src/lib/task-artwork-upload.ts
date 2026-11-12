import type { NextRequest } from 'next/server'
import type { ArtworkRow } from '@/lib/design-studio'
import { ARTWORK_TYPES_LABEL, MAX_ARTWORK_BYTES, artworkFileType, artworkTargetForTask, logArtworkUpload, saveArtworkFromTemp } from '@/lib/design-storage'
import { retireOutdatedParts, uploadSlotsForLine } from '@/lib/design-tasks'
import { TooLargeError, discardTemp, streamToTempFile, type TempFile } from '@/lib/library-storage'
import { enqueueDrivePush } from '@/lib/drive-push-queue'
import { fileKindOf, isFileKind } from '@/lib/task-files'

const TOO_LARGE = 'File lớn hơn 200 MB'
const MOCKUP_MIME = ['image/png', 'image/jpeg']
const MAX_PART_PARAM = 200

/**
 * One file of a task. `kind` is PRINT (default) or MOCKUP. `printArea` names the part the file belongs to (a template area,
 * or the part being replaced); without it the part is read from the file name, so `front.png` + `back.png` are two files
 * and a second `front.png` is version 2 of "front". The caller has checked who may upload.
 */
export async function receiveTaskArtwork(req: NextRequest, taskKey: string, uploadedById: string): Promise<{ artwork: ArtworkRow } | { error: string; status: number }> {
  const sp = req.nextUrl.searchParams
  const printArea = sp.get('printArea')?.trim() ?? ''
  const fileName = sp.get('fileName')?.trim() ?? ''
  const kindParam = sp.get('kind')
  if (kindParam && !isFileKind(kindParam)) return { error: 'kind phải là PRINT hoặc MOCKUP', status: 400 }
  const kind = fileKindOf(kindParam)
  if (!fileName) return { error: 'Thiếu fileName', status: 400 }
  if (printArea.length > MAX_PART_PARAM) return { error: 'Tên phần file quá dài', status: 400 }
  const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const type = artworkFileType(fileName, contentType)
  if (!type) {
    return { error: `Không nhận loại file này: ${fileName}. Chỉ nhận ${ARTWORK_TYPES_LABEL}.`, status: 400 }
  }
  if (kind === 'MOCKUP' && !MOCKUP_MIME.includes(type.mimeType)) {
    return { error: `Mockup chỉ nhận ảnh PNG hoặc JPG: ${fileName}`, status: 400 }
  }
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ARTWORK_BYTES) return { error: TOO_LARGE, status: 413 }

  const target = await artworkTargetForTask(taskKey)
  if (target === 'no-task') return { error: 'Không tìm thấy task', status: 404 }
  if (target === 'no-line') return { error: 'Dòng đơn của task đang được đồng bộ lại — thử lại sau vài giây', status: 409 }

  let temp: TempFile | null = null
  try {
    const derivePart = printArea ? undefined : { slots: kind === 'PRINT' ? await uploadSlotsForLine(target.orderId, target.shopifyLineId) : [] }
    temp = await streamToTempFile(req.body, MAX_ARTWORK_BYTES)
    if (temp.size === 0) return { error: 'File rỗng', status: 400 }
    const artwork = await saveArtworkFromTemp({ target, kind, printArea, derivePart, fileName, mimeType: contentType, temp, uploadedById })
    await logArtworkUpload(target, artwork, uploadedById)
    if (kind === 'PRINT') await retireOutdatedParts(target.orderId, target.shopifyLineId, uploadedById)
    enqueueDrivePush(artwork.id)
    return { artwork }
  } catch (err: any) {
    if (err instanceof TooLargeError) return { error: TOO_LARGE, status: 413 }
    console.error('[design artwork] upload failed:', err?.message ?? err)
    return { error: err?.message ?? 'Lỗi tải lên', status: 500 }
  } finally {
    await discardTemp(temp)
  }
}
