import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { CredentialError, MAX_CREDENTIAL_BYTES, connectDriveWithCredential, parseDriveCredential } from '@/lib/google-drive-connect'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = MAX_CREDENTIAL_BYTES * 3
const TOO_LARGE = 'Nội dung gửi lên lớn hơn 16 KB — đây không phải file google_drive_token.json.'

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error

  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })
  const raw = await req.text().catch(() => '')
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ error: TOO_LARGE }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Nội dung gửi lên không hợp lệ.' }, { status: 400 })
  }

  try {
    const result = await connectDriveWithCredential(parseDriveCredential(body))
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    if (err instanceof CredentialError) return NextResponse.json({ error: err.message }, { status: err.status })
    console.error('[google drive] connect with credential failed:', err?.name ?? 'Error')
    return NextResponse.json({ error: 'Không lưu được kết nối Google Drive. Thử lại sau.' }, { status: 500 })
  }
}
