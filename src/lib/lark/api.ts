import type { LarkConfig } from '@/lib/lark/settings'

export const LARK_HOST = 'https://open.larksuite.com'

export class LarkApiError extends Error {}

export type LarkApi = {
  reply(messageId: string, text: string): Promise<void>
  sendToChat(chatId: string, text: string, mentionOpenId?: string): Promise<void>
  botOpenId(): Promise<string | null>
  userName(openId: string): Promise<string | null>
}

type CachedToken = { appId: string; token: string; expiresAt: number }

declare global {
  // eslint-disable-next-line no-var
  var __larkTenantToken: CachedToken | undefined
  // eslint-disable-next-line no-var
  var __larkBotOpenId: { appId: string; openId: string } | undefined
}

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const RENEW_BEFORE_MS = 5 * 60_000
const TOKEN_INVALID_CODES = [99991661, 99991663, 99991664]
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

export function resetLarkCache(): void {
  globalThis.__larkTenantToken = undefined
  globalThis.__larkBotOpenId = undefined
}

const seg = (id: string) => encodeURIComponent(id)

export const LARK_TIMEOUT_MS = 10_000

export function larkApi(
  config: Pick<LarkConfig, 'appId' | 'appSecret'>, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, timeoutMs: number = LARK_TIMEOUT_MS,
): LarkApi {
  async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown; token?: string }, query = ''): Promise<any> {
    const headers: Record<string, string> = { ...JSON_HEADERS }
    if (init.token) headers.Authorization = `Bearer ${init.token}`
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(`${LARK_HOST}${path}${query}`, {
        method: init.method, headers, signal, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (e) {
      throw new LarkApiError(`Lark ${path}: ${signal.aborted ? 'timeout' : `network ${(e as Error)?.name ?? 'error'}`}`)
    }
    const data: any = await res.json().catch(() => null)
    if (signal.aborted && data === null) throw new LarkApiError(`Lark ${path}: timeout`)
    const code = data && typeof data.code === 'number' ? data.code : null
    if (!res.ok || code !== 0) {
      const msg = typeof data?.msg === 'string' ? data.msg.slice(0, 200) : `HTTP ${res.status}`
      if (code !== null && TOKEN_INVALID_CODES.includes(code)) globalThis.__larkTenantToken = undefined
      throw new LarkApiError(`Lark ${path}: ${code ?? res.status} ${msg}`)
    }
    return data
  }

  async function token(): Promise<string> {
    const cached = globalThis.__larkTenantToken
    if (cached && cached.appId === config.appId && now() < cached.expiresAt - RENEW_BEFORE_MS) return cached.token
    const data = await call(TOKEN_PATH, { method: 'POST', body: { app_id: config.appId, app_secret: config.appSecret } })
    const value = typeof data.tenant_access_token === 'string' ? data.tenant_access_token : ''
    if (!value) throw new LarkApiError(`Lark ${TOKEN_PATH}: no token`)
    const expire = typeof data.expire === 'number' && data.expire > 0 ? data.expire : 600
    globalThis.__larkTenantToken = { appId: config.appId, token: value, expiresAt: now() + expire * 1000 }
    return value
  }

  const textContent = (text: string) => JSON.stringify({ text })

  return {
    async reply(messageId, text) {
      await call(`/open-apis/im/v1/messages/${seg(messageId)}/reply`, { method: 'POST', token: await token(), body: { msg_type: 'text', content: textContent(text) } })
    },
    async sendToChat(chatId, text, mentionOpenId) {
      const body = mentionOpenId ? `<at user_id="${mentionOpenId.replace(/["<>]/g, '')}"></at> ${text}` : text
      await call('/open-apis/im/v1/messages', { method: 'POST', token: await token(), body: { receive_id: chatId, msg_type: 'text', content: textContent(body) } }, '?receive_id_type=chat_id')
    },
    async botOpenId() {
      const cached = globalThis.__larkBotOpenId
      if (cached && cached.appId === config.appId) return cached.openId
      const data = await call('/open-apis/bot/v3/info', { method: 'GET', token: await token() })
      const openId = typeof data?.bot?.open_id === 'string' ? data.bot.open_id : null
      if (openId) globalThis.__larkBotOpenId = { appId: config.appId, openId }
      return openId
    },
    async userName(openId) {
      try {
        const data = await call(`/open-apis/contact/v3/users/${seg(openId)}`, { method: 'GET', token: await token() }, '?user_id_type=open_id')
        const name = data?.data?.user?.name
        return typeof name === 'string' && name.trim() ? name.trim() : null
      } catch {
        return null
      }
    },
  }
}
