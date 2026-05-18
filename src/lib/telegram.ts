import { prisma } from '@/lib/db'

async function getTelegramConfig() {
  const settings = await prisma.appSetting.findMany({
    where: { key: { in: ['telegram.botToken', 'telegram.chatId'] } },
  })
  const fromDb = Object.fromEntries(settings.map(s => [s.key, s.value]))
  return {
    token: fromDb['telegram.botToken'] || process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: fromDb['telegram.chatId'] || process.env.TELEGRAM_CHAT_ID || '',
  }
}

export async function getTelegramStatus() {
  const { token, chatId } = await getTelegramConfig()
  return {
    configured: Boolean(token && chatId),
    botTokenMasked: token ? `${token.slice(0, 6)}...${token.slice(-4)}` : '',
    chatId,
  }
}

export async function saveTelegramConfig(botToken: string, chatId: string) {
  await prisma.appSetting.upsert({
    where: { key: 'telegram.botToken' },
    create: { key: 'telegram.botToken', value: botToken },
    update: { value: botToken },
  })
  await prisma.appSetting.upsert({
    where: { key: 'telegram.chatId' },
    create: { key: 'telegram.chatId', value: chatId },
    update: { value: chatId },
  })
}

export async function sendTelegramMessage(text: string, chatIdOverride?: string | number) {
  const { token, chatId } = await getTelegramConfig()
  const targetChatId = chatIdOverride || chatId
  if (!token || !targetChatId) return { skipped: true }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: 'HTML' }),
  })
  if (!res.ok) return { skipped: false, error: await res.text() }
  return { skipped: false, ok: true }
}
