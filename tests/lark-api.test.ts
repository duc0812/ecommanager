import { describe, it, expect, beforeAll } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'crypto'
import { LARK_HOST, LarkApiError, larkApi, resetLarkCache, type LarkApi } from '@/lib/lark/api'
import { decryptLarkPayload, larkSignature } from '@/lib/lark/crypto'

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const TOKEN = { [TOKEN_PATH]: { code: 0, tenant_access_token: 't-1', expire: 7200 } }

const calls: { url: string; init: RequestInit }[] = []
const last = () => calls[calls.length - 1]
const fakeFetch = (answers: Record<string, unknown>, status: Record<string, number> = {}) => (async (url: string, init: RequestInit) => {
  calls.push({ url, init })
  const path = new URL(url).pathname
  return new Response(JSON.stringify(answers[path] ?? { code: 0 }), { status: status[path] ?? 200, headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

function encryptForTest(plain: string, key: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key, 'utf8').digest(), iv)
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

let api: LarkApi

beforeAll(() => { resetLarkCache(); calls.length = 0 })

describe('Lark API client', () => {
  it('one token serves several calls and is renewed before it expires', async () => {
    let t = 0
    api = larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, fakeFetch(TOKEN), () => t)
    await api.reply('om_1', 'xin chào'); await api.reply('om_2', 'lần hai')
    expect(calls.filter(c => c.url.endsWith('/tenant_access_token/internal'))).toHaveLength(1)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ app_id: 'cli_a1', app_secret: 's3cret' })
    expect(calls[0].url).toBe(`${LARK_HOST}${TOKEN_PATH}`)
    t = (7200 - 299) * 1000; await api.reply('om_3', 'lần ba')
    expect(calls.filter(c => c.url.endsWith('/tenant_access_token/internal'))).toHaveLength(2)
  })

  it('reply and group message have the documented shape', async () => {
    expect(calls[1].url).toBe('https://open.larksuite.com/open-apis/im/v1/messages/om_1/reply')
    expect(calls[1].init.method).toBe('POST')
    expect((calls[1].init.headers as any).Authorization).toBe('Bearer t-1')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ msg_type: 'text', content: JSON.stringify({ text: 'xin chào' }) })
    await api.sendToChat('oc_group', 'cần chủ shop', 'ou_owner')
    expect(last().url).toBe('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id')
    const body = JSON.parse(last().init.body as string)
    expect(body).toMatchObject({ receive_id: 'oc_group', msg_type: 'text' })
    expect(JSON.parse(body.content).text).toBe('<at user_id="ou_owner"></at> cần chủ shop')
    await api.sendToChat('oc_group', 'không nhắc ai')
    expect(JSON.parse(JSON.parse(last().init.body as string).content).text).toBe('không nhắc ai')
  })

  it('a Lark error code throws without leaking the secret or the token', async () => {
    resetLarkCache()
    const failing = larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, fakeFetch({ ...TOKEN, '/open-apis/im/v1/messages/om_9/reply': { code: 230002, msg: 'bot not in chat' } }, { '/open-apis/im/v1/messages/om_9/reply': 400 }))
    const err = await failing.reply('om_9', 'x').catch(e => e)
    expect(err).toBeInstanceOf(LarkApiError)
    expect(err.message).toContain('230002')
    expect(err.message).not.toContain('s3cret'); expect(err.message).not.toContain('t-1')
    resetLarkCache()
    const noToken = larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, fakeFetch({ [TOKEN_PATH]: { code: 10014, msg: 'app secret invalid' } }))
    const tokenErr = await noToken.reply('om_9', 'x').catch(e => e)
    expect(tokenErr).toBeInstanceOf(LarkApiError); expect(tokenErr.message).toContain('10014'); expect(tokenErr.message).not.toContain('s3cret')
  })

  it('userName is null when Lark refuses, the name otherwise; botOpenId is fetched once', async () => {
    resetLarkCache()
    const refusing = larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, fakeFetch({ ...TOKEN, '/open-apis/contact/v3/users/ou_x': { code: 41050, msg: 'no permission' } }))
    expect(await refusing.userName('ou_x')).toBeNull()
    calls.length = 0
    const ok = larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, fakeFetch({
      ...TOKEN,
      '/open-apis/contact/v3/users/ou_lan': { code: 0, data: { user: { name: 'Lan' } } },
      '/open-apis/bot/v3/info': { code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } },
    }))
    expect(await ok.userName('ou_lan')).toBe('Lan')
    expect(calls.find(c => c.url.includes('/contact/v3/users/'))!.url).toBe('https://open.larksuite.com/open-apis/contact/v3/users/ou_lan?user_id_type=open_id')
    expect(await ok.botOpenId()).toBe('ou_bot'); expect(await ok.botOpenId()).toBe('ou_bot')
    expect(calls.filter(c => c.url.endsWith('/bot/v3/info'))).toHaveLength(1)
  })

  it('a Lark call that hangs is cut off by a timeout and surfaces as LarkApiError', async () => {
    resetLarkCache()
    const signals: (AbortSignal | null | undefined)[] = []
    const hanging = (async (url: string, init: RequestInit) => {
      signals.push(init.signal)
      if (new URL(url).pathname === TOKEN_PATH) return new Response(JSON.stringify(TOKEN[TOKEN_PATH]), { status: 200 })
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })
    }) as unknown as typeof fetch
    const started = Date.now()
    const err = await larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, hanging, Date.now, 50).reply('om_hang', 'x').catch(e => e)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(err).toBeInstanceOf(LarkApiError)
    expect(err.message).toBe('Lark /open-apis/im/v1/messages/om_hang/reply: timeout')
    expect(err.message).not.toContain('s3cret'); expect(err.message).not.toContain('t-1')
    expect(signals.every(s => s instanceof AbortSignal)).toBe(true)
    resetLarkCache()
    const seen: (AbortSignal | null | undefined)[] = []
    await larkApi({ appId: 'cli_a1', appSecret: 's3cret' }, (async (url: string, init: RequestInit) => { seen.push(init.signal); return fakeFetch(TOKEN)(url, init) }) as unknown as typeof fetch).reply('om_ok', 'x')
    expect(seen.length).toBeGreaterThan(0); expect(seen.every(s => s instanceof AbortSignal)).toBe(true)
  })

  it('signature and decryption', () => {
    expect(larkSignature('1700000000', 'n0nce', 'ek', '{"encrypt":"abc"}')).toBe(createHash('sha256').update('1700000000n0nceek{"encrypt":"abc"}').digest('hex'))
    expect(JSON.parse(decryptLarkPayload(encryptForTest('{"type":"url_verification"}', 'ek'), 'ek'))).toEqual({ type: 'url_verification' })
    expect(() => decryptLarkPayload(encryptForTest('{"a":1}', 'ek'), 'other')).toThrow()
    expect(() => decryptLarkPayload('not base64 at all', 'ek')).toThrow()
  })

  it('decrypts the sample published in the Lark documentation', () => {
    expect(decryptLarkPayload('P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=', 'test key')).toBe('hello world')
  })
})
