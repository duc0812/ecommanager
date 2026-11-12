import { NextRequest, NextResponse } from 'next/server'
import { requireSuperadmin } from '@/lib/api-auth'
import { readBody } from '@/lib/design-agent/route-http'
import { LARK_NOT_CONFIGURED, getLarkConfig, getLarkStatus, isLarkConfigured, saveLarkConfig, type LarkConfig } from '@/lib/lark/settings'
import { LarkApiError, larkApi } from '@/lib/lark/api'

export const dynamic = 'force-dynamic'

const TEXT_FIELDS = ['appId', 'appSecret', 'verificationToken', 'encryptKey', 'chatId', 'ownerOpenId'] as const

export async function GET(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(await getLarkStatus())
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await readBody(req)
  const patch: Partial<LarkConfig> = {}
  for (const k of TEXT_FIELDS) {
    if (typeof body[k] === 'string') patch[k] = (body[k] as string).trim()
  }
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  try {
    await saveLarkConfig(patch)
  } catch (e) {
    if ((e as Error)?.message === LARK_NOT_CONFIGURED) return NextResponse.json({ error: LARK_NOT_CONFIGURED }, { status: 400 })
    console.error('[lark] lưu cài đặt lỗi', (e as Error)?.message ?? e)
    return NextResponse.json({ error: 'Lỗi máy chủ.' }, { status: 500 })
  }
  return NextResponse.json(await getLarkStatus())
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const config = await getLarkConfig()
  if (!isLarkConfigured(config)) return NextResponse.json({ error: 'Chưa cấu hình đủ Lark' }, { status: 400 })
  try {
    await larkApi(config).sendToChat(config.chatId, 'Ecom Manager: bot Design Agent đã kết nối với nhóm này.')
  } catch (e) {
    if (e instanceof LarkApiError) return NextResponse.json({ error: e.message }, { status: 502 })
    console.error('[lark] gửi tin thử lỗi', (e as Error)?.message ?? e)
    return NextResponse.json({ error: 'Lỗi máy chủ.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
