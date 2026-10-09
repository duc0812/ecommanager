import { NextRequest, NextResponse } from 'next/server'
import { requireApiAccess } from '@/lib/api-auth'
import { TooLargeError, discardTemp, streamToTempFile, type TempFile } from '@/lib/library-storage'
import { LibraryError, PSD_MAX_BYTES, assertUploadTarget, toProductGid, uploadEntryPsd } from '@/lib/repos/artwork-library'

const PSD_MAGIC = Buffer.from('8BPS', 'latin1')

export async function PUT(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  const sp = req.nextUrl.searchParams
  const storeId = sp.get('storeId')?.trim() ?? ''
  const productId = toProductGid(sp.get('productId'))
  const templateId = sp.get('templateId')?.trim() ?? ''
  const fileName = sp.get('fileName')?.trim() ?? ''
  const rawOptionKey = sp.get('optionKey') ?? ''
  if (!storeId || !productId || !templateId || !fileName) return NextResponse.json({ error: 'Thiếu storeId, productId, templateId hoặc fileName' }, { status: 400 })
  if (!/\.psd$/i.test(fileName)) return NextResponse.json({ error: 'Chỉ nhận file .psd' }, { status: 400 })
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > PSD_MAX_BYTES) return NextResponse.json({ error: 'File lớn hơn 1 GB' }, { status: 413 })

  let temp: TempFile | null = null
  try {
    const optionKey = await assertUploadTarget(storeId, productId, templateId, rawOptionKey)
    temp = await streamToTempFile(req.body, PSD_MAX_BYTES)
    if (temp.size === 0) return NextResponse.json({ error: 'File rỗng' }, { status: 400 })
    if (!temp.head.subarray(0, 4).equals(PSD_MAGIC)) return NextResponse.json({ error: 'File không phải PSD (thiếu 8BPS)' }, { status: 400 })
    const result = await uploadEntryPsd({ storeId, shopifyProductId: productId, templateId, optionKey, fileName, temp, uploadedById: auth.user.id })
    return NextResponse.json(result)
  } catch (err: any) {
    if (err instanceof TooLargeError) return NextResponse.json({ error: 'File lớn hơn 1 GB' }, { status: 413 })
    if (err instanceof LibraryError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[artwork library] upload failed:', err?.message ?? err)
    return NextResponse.json({ error: err?.message ?? 'Lỗi tải lên' }, { status: 500 })
  } finally {
    await discardTemp(temp)
  }
}
