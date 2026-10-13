import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { deleteSettings, saveSetting } from '@/lib/token-store'
import { GOOGLE_KEYS, getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { DriveError, deleteFile, driveFileViewUrl, ensureRootFolder, shareAnyoneReader, startResumableUpload, uploadChunk } from '@/lib/google-drive'

export const dynamic = 'force-dynamic'

const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function googleSays(err: any): string {
  const message = err instanceof DriveError ? err.message : (err?.message ?? 'lỗi không rõ')
  return String(message).replace(/^Google Drive:\s*/, '')
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const cfg = await getGoogleConfig()
  if (!isDriveConfigured(cfg)) return NextResponse.json({ error: 'Google Drive chưa được kết nối.' }, { status: 400 })

  let fileId: string | null = null
  try {
    if (cfg.testFileId) {
      await deleteFile(cfg.testFileId).catch(() => {})
      await deleteSettings([GOOGLE_KEYS.testFileId])
    }
    const parentId = await ensureRootFolder()
    const name = `drive-test-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    const sessionUrl = await startResumableUpload({ name, mimeType: 'image/png', size: TEST_PNG.length, parentId })
    const sent = await uploadChunk(sessionUrl, TEST_PNG, 0, TEST_PNG.length)
    if (!sent.done || typeof sent.file?.id !== 'string' || !sent.file.id) throw new DriveError('Google Drive không trả về id file.')
    fileId = sent.file.id as string
    await shareAnyoneReader(fileId)
    await saveSetting(GOOGLE_KEYS.testFileId, fileId)
    const link = typeof sent.file.webViewLink === 'string' && sent.file.webViewLink ? sent.file.webViewLink : driveFileViewUrl(fileId)
    return NextResponse.json({ ok: true, fileId, name, link })
  } catch (err: any) {
    if (fileId) await deleteFile(fileId).catch(() => {})
    const googleMessage = googleSays(err)
    return NextResponse.json({ error: `Chưa tạo được file thử trên Google Drive. Google trả lời: "${googleMessage}"`, googleMessage }, { status: 502 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const cfg = await getGoogleConfig()
  if (!cfg.testFileId) return NextResponse.json({ ok: true, deleted: false })
  try {
    await deleteFile(cfg.testFileId)
  } catch (err: any) {
    const googleMessage = googleSays(err)
    return NextResponse.json({ error: `Chưa xoá được file thử. Google trả lời: "${googleMessage}"`, googleMessage }, { status: 502 })
  }
  await deleteSettings([GOOGLE_KEYS.testFileId])
  return NextResponse.json({ ok: true, deleted: true })
}
