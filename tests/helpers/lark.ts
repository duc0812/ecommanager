import { createCipheriv, createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'

export const LARK_TEST_CONFIG = {
  appId: 'cli_test', appSecret: 'app-secret-test-1', verificationToken: 'vt-1', chatId: 'oc_group', ownerOpenId: 'ou_owner',
}

export function encryptForTest(plain: string, key: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key, 'utf8').digest(), iv)
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

export const dropLarkSettings = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: 'lark.' } } })

type EvtOver = {
  eventId?: string; messageId?: string; token?: string; eventType?: string; chatId?: string; senderType?: string
  senderOpenId?: string; messageType?: string; text?: string; mentions?: unknown[]
}

export function evt(over: EvtOver = {}) {
  const eventId = over.eventId ?? `ev-${Math.random().toString(36).slice(2)}`
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: over.eventType ?? 'im.message.receive_v1', token: over.token ?? 'vt-1', app_id: 'cli_test', create_time: '1700000000000', tenant_key: 't1' },
    event: {
      sender: { sender_id: { open_id: over.senderOpenId ?? 'ou_lan' }, sender_type: over.senderType ?? 'user', tenant_key: 't1' },
      message: {
        message_id: over.messageId ?? `om_${eventId}`, chat_id: over.chatId ?? 'oc_group', chat_type: 'group', message_type: over.messageType ?? 'text',
        content: JSON.stringify({ text: over.text ?? '@_user_1 LIT6262_1 sửa sao trên mũ' }),
        mentions: over.mentions ?? [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Design Bot', tenant_key: 't1' }],
      },
    },
  }
}
