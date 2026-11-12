import { getSettings, saveSetting, deleteSettings } from '@/lib/token-store'
import { maskApiKey } from '@/lib/tracking/parcelpanel-config'

export const LARK_KEYS = {
  appId: 'lark.appId',
  appSecret: 'lark.appSecret',
  verificationToken: 'lark.verificationToken',
  encryptKey: 'lark.encryptKey',
  chatId: 'lark.chatId',
  ownerOpenId: 'lark.ownerOpenId',
  enabled: 'lark.enabled',
} as const

export type LarkConfig = {
  appId: string
  appSecret: string
  verificationToken: string
  encryptKey: string
  chatId: string
  ownerOpenId: string
  enabled: boolean
}

export type LarkStatus = {
  enabled: boolean
  configured: boolean
  appId: string
  chatId: string
  ownerOpenId: string
  hasAppSecret: boolean
  appSecretMasked: string | null
  hasVerificationToken: boolean
  verificationTokenMasked: string | null
  hasEncryptKey: boolean
  encryptKeyMasked: string | null
}

export const LARK_NOT_CONFIGURED = 'Điền App ID, App Secret, Verification Token và Chat ID trước khi bật'

const SECRETS = ['appSecret', 'verificationToken', 'encryptKey'] as const
const PLAIN = ['appId', 'chatId', 'ownerOpenId'] as const

export async function getLarkConfig(): Promise<LarkConfig> {
  const raw = await getSettings(Object.values(LARK_KEYS))
  const s = (k: keyof typeof LARK_KEYS) => raw[LARK_KEYS[k]]?.trim() ?? ''
  return {
    appId: s('appId'), appSecret: s('appSecret'), verificationToken: s('verificationToken'), encryptKey: s('encryptKey'),
    chatId: s('chatId'), ownerOpenId: s('ownerOpenId'), enabled: s('enabled') === '1',
  }
}

export function isLarkConfigured(c: LarkConfig): boolean {
  return !!(c.appId && c.appSecret && c.verificationToken && c.chatId)
}

export async function saveLarkConfig(patch: Partial<LarkConfig>): Promise<void> {
  const current = await getLarkConfig()
  const next: LarkConfig = { ...current }
  for (const k of PLAIN) {
    if (typeof patch[k] === 'string') next[k] = (patch[k] as string).trim()
  }
  for (const k of SECRETS) {
    const v = typeof patch[k] === 'string' ? (patch[k] as string).trim() : ''
    if (!v) continue
    next[k] = k === 'encryptKey' && v === '-' ? '' : v
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (next.enabled && !isLarkConfigured(next)) throw new Error(LARK_NOT_CONFIGURED)
  const cleared: string[] = []
  for (const k of [...PLAIN, ...SECRETS]) {
    if (next[k] === current[k]) continue
    if (next[k]) await saveSetting(LARK_KEYS[k], next[k])
    else cleared.push(LARK_KEYS[k])
  }
  if (cleared.length) await deleteSettings(cleared)
  if (next.enabled !== current.enabled) await saveSetting(LARK_KEYS.enabled, next.enabled ? '1' : '0')
}

export async function getLarkStatus(): Promise<LarkStatus> {
  const c = await getLarkConfig()
  return {
    enabled: c.enabled,
    configured: isLarkConfigured(c),
    appId: c.appId,
    chatId: c.chatId,
    ownerOpenId: c.ownerOpenId,
    hasAppSecret: !!c.appSecret,
    appSecretMasked: maskApiKey(c.appSecret),
    hasVerificationToken: !!c.verificationToken,
    verificationTokenMasked: maskApiKey(c.verificationToken),
    hasEncryptKey: !!c.encryptKey,
    encryptKeyMasked: maskApiKey(c.encryptKey),
  }
}
