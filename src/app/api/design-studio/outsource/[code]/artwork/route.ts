import { NextRequest, NextResponse } from 'next/server'
import { assertOutsourceUpload, currentOutsourceTemplate, loadOutsource, OutsourceError, visibleOutsource } from '@/lib/design-outsource'
import { outsourceRoute } from '@/lib/design-outsource-route'
import { ARTWORK_TYPES_LABEL, MAX_ARTWORK_BYTES, artworkFileType, artworkTargetForTask, saveArtworkFromTemp } from '@/lib/design-storage'
import { discardTemp, streamToTempFile, TooLargeError, type TempFile } from '@/lib/library-storage'
import { enqueueDrivePush } from '@/lib/drive-push-queue'
import { requiredSlotsFor } from '@/lib/design-tasks'
import { canManageOutsource } from '@/lib/roles'

export const dynamic = 'force-dynamic'
export function PUT(req: NextRequest, { params }: { params: { code: string } }) {
  return outsourceRoute(req, async user => {
    if (canManageOutsource(user)) throw new OutsourceError('Chỉ người được giao upload qua màn outsource', 403)
    const a = await visibleOutsource(params.code, user)
    const revision = Number(req.nextUrl.searchParams.get('revision'))
    if (revision !== a.revision) throw new OutsourceError('Lần giao đã thay đổi, tải lại trước khi upload', 409)
    if (!['DOING', 'REJECTED'].includes(a.task.status)) throw new OutsourceError('Bắt đầu làm hoặc rút mẫu về trước khi upload', 409)
    const kind = req.nextUrl.searchParams.get('kind') ?? 'PRINT'
    if (kind !== 'PRINT' && kind !== 'MOCKUP') throw new OutsourceError('Loại file không hợp lệ')
    const fileName = req.nextUrl.searchParams.get('fileName')?.trim() ?? ''
    const printArea = req.nextUrl.searchParams.get('printArea')?.trim() ?? ''
    const type = artworkFileType(fileName, req.headers.get('content-type') ?? '')
    if (!type || !fileName || fileName.length > 250) throw new OutsourceError(`Chỉ nhận ${ARTWORK_TYPES_LABEL}`)
    if (kind === 'MOCKUP' && !['image/png', 'image/jpeg'].includes(type.mimeType)) throw new OutsourceError('Mockup chỉ nhận PNG hoặc JPG')
    const current = await currentOutsourceTemplate(a)
    if (!current) throw new OutsourceError('Template không còn khả dụng, liên hệ nội bộ', 409)
    const slots = requiredSlotsFor(JSON.parse(a.templateSnapshot))
    if (kind === 'PRINT' && slots.length && !slots.includes(printArea)) throw new OutsourceError('Chọn đúng vùng in trên template')
    if (printArea.length > 60) throw new OutsourceError('Tên vùng in quá dài')
    if (Number(req.headers.get('content-length')) > MAX_ARTWORK_BYTES) throw new OutsourceError('File lớn hơn 200 MB', 413)
    const target = await artworkTargetForTask(a.task.taskKey)
    if (typeof target === 'string') throw new OutsourceError('Task đang đồng bộ, thử lại sau', 409)
    let temp: TempFile | null = null
    try {
      temp = await streamToTempFile(req.body, MAX_ARTWORK_BYTES)
      if (!temp.size) throw new OutsourceError('File rỗng')
      const artwork = await saveArtworkFromTemp({
        target, kind, printArea: kind === 'MOCKUP' ? 'Mockup' : printArea || 'Print',
        fileName, mimeType: type.mimeType, temp, uploadedById: user.id,
        outsource: { id: a.id, revision, templateVersion: a.templateVersion, validate: tx => assertOutsourceUpload(tx, a.id, revision, user.id, a.templateVersion) },
      })
      enqueueDrivePush(artwork.id)
      return NextResponse.json(await loadOutsource(a.code, user))
    } catch (error) {
      if (error instanceof TooLargeError) throw new OutsourceError('File lớn hơn 200 MB', 413)
      throw error
    } finally { await discardTemp(temp) }
  })
}
