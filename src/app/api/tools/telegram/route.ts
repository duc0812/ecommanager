import { NextRequest, NextResponse } from 'next/server'
import { getTelegramStatus, saveTelegramConfig, sendTelegramMessage } from '@/lib/telegram'
import { requireApiAccess, requireSuperadmin } from '@/lib/api-auth'
import { maskedForSuperadminOnly } from '@/lib/secret-view'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await requireApiAccess(req)
  if ('error' in auth) return auth.error
  return NextResponse.json(maskedForSuperadminOnly(auth.user, await getTelegramStatus(), ['botTokenMasked']))
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const botToken = String(body.botToken ?? '').trim()
  const chatId = String(body.chatId ?? '').trim()
  if (!botToken || !chatId) {
    return NextResponse.json({ error: 'Bot token and chat ID are required' }, { status: 400 })
  }
  await saveTelegramConfig(botToken, chatId)
  return NextResponse.json({ ok: true, status: await getTelegramStatus() })
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperadmin(req)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => ({}))
  const message = String(body.message ?? '').trim().slice(0, 500) || 'Ecom Manager Telegram test message.'
  const result = await sendTelegramMessage(message)
  return NextResponse.json(result)
}
