import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { getLarkConfig } from '@/lib/lark/settings'
import { decryptLarkPayload, larkSignature } from '@/lib/lark/crypto'

export type LarkHeaders = { timestamp: string | null; nonce: string | null; signature: string | null }

export type AcceptedLarkMessage = {
  eventId: string
  messageId: string
  senderOpenId: string
  text: string
  mentions: { key: string; openId: string | null; name: string }[]
}

type Received = { status: number; body: Record<string, unknown>; accepted?: AcceptedLarkMessage }

const MAX_TEXT = 4000
const BAD: Received = { status: 400, body: { error: 'bad request' } }
const UNAUTHORIZED: Received = { status: 401, body: { error: 'unauthorized' } }
const ignored = (why: string): Received => ({ status: 200, body: { ok: true, ignored: why } })

function sameSecret(given: unknown, stored: string): boolean {
  if (typeof given !== 'string' || !given || !stored) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseObject(raw: string): Record<string, any> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function messageText(content: unknown): string {
  const parsed = typeof content === 'string' ? parseObject(content) : null
  return str(parsed?.text).slice(0, MAX_TEXT)
}

export async function receiveLarkEvent(rawBody: string, headers: LarkHeaders): Promise<Received> {
  let body = parseObject(rawBody)
  if (!body) return BAD
  const config = await getLarkConfig()

  if ('encrypt' in body) {
    if (!config.encryptKey || typeof body.encrypt !== 'string') return UNAUTHORIZED
    let plain: Record<string, any> | null
    try { plain = parseObject(decryptLarkPayload(body.encrypt, config.encryptKey)) } catch { return UNAUTHORIZED }
    if (!plain) return UNAUTHORIZED
    if (plain.type !== 'url_verification') {
      const { timestamp, nonce, signature } = headers
      if (!timestamp || !nonce || !signature) return UNAUTHORIZED
      if (!sameSecret(signature.toLowerCase(), larkSignature(timestamp, nonce, config.encryptKey, rawBody))) return UNAUTHORIZED
    }
    body = plain
  } else if (config.encryptKey) {
    return UNAUTHORIZED
  }

  if (body.type === 'url_verification') {
    if (!sameSecret(body.token, config.verificationToken)) return UNAUTHORIZED
    return { status: 200, body: { challenge: str(body.challenge) } }
  }

  const header = body.header && typeof body.header === 'object' ? body.header : {}
  if (!sameSecret(header.token, config.verificationToken)) return UNAUTHORIZED
  if (!config.enabled) return ignored('disabled')

  const event = body.event && typeof body.event === 'object' ? body.event : {}
  const message = event.message && typeof event.message === 'object' ? event.message : {}
  if (header.event_type !== 'im.message.receive_v1') return ignored('event_type')
  if (!config.chatId || message.chat_id !== config.chatId) return ignored('chat')
  if (event.sender?.sender_type !== 'user') return ignored('sender')
  if (message.message_type !== 'text') return ignored('message_type')
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  if (mentions.length === 0) return ignored('mention')

  const eventId = str(header.event_id)
  const messageId = str(message.message_id)
  const senderOpenId = str(event.sender?.sender_id?.open_id)
  if (!eventId || !messageId || !senderOpenId) return BAD
  const accepted: AcceptedLarkMessage = {
    eventId, messageId, senderOpenId, text: messageText(message.content),
    mentions: mentions.slice(0, 50).map((m: any) => ({ key: str(m?.key), openId: str(m?.id?.open_id) || null, name: str(m?.name) })),
  }
  try {
    await prisma.larkEvent.create({ data: { eventId, messageId, senderOpenId, text: accepted.text } })
  } catch (e: any) {
    if (e?.code === 'P2002') return ignored('duplicate')
    throw e
  }
  return { status: 200, body: { ok: true }, accepted }
}
