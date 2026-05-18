import { NextRequest, NextResponse } from 'next/server'
import { getTelegramStatus, saveTelegramConfig, sendTelegramMessage } from '@/lib/telegram'
import { buildProxyCheckMessage } from '@/lib/proxy-maintenance'

type TelegramUpdate = {
  message?: {
    chat?: { id?: string | number }
    text?: string
  }
}

function normalizeCommand(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isProxyCheckCommand(text: string) {
  const command = normalizeCommand(text)
  return command === 'check'
    || command === '/check'
    || command.startsWith('/check@')
    || command === '@proxymaintainbot check'
    || command.startsWith('@proxymaintainbot check ')
}

async function handleTelegramUpdate(update: TelegramUpdate) {
  const chatId = update.message?.chat?.id
  const text = update.message?.text || ''
  if (!chatId || !isProxyCheckCommand(text)) {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const result = await sendTelegramMessage(await buildProxyCheckMessage(), chatId)
  return NextResponse.json({ ok: true, result })
}

export async function GET() {
  return NextResponse.json(await getTelegramStatus())
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (body.message) return handleTelegramUpdate(body)

  const botToken = String(body.botToken ?? '').trim()
  const chatId = String(body.chatId ?? '').trim()
  if (!botToken || !chatId) {
    return NextResponse.json({ error: 'Bot token and chat ID are required' }, { status: 400 })
  }
  await saveTelegramConfig(botToken, chatId)
  return NextResponse.json({ ok: true, status: await getTelegramStatus() })
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const result = await sendTelegramMessage(body.message || 'Ecom Manager Telegram test message.')
  return NextResponse.json(result)
}
