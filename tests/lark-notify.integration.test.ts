import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { LarkApiError, resetLarkCache } from '@/lib/lark/api'
import { saveLarkConfig } from '@/lib/lark/settings'
import { notifyNeedsOwner } from '@/lib/design-agent/notify'
import { PUT } from '@/app/api/design-agent/settings/lark/route'
import { superRequest, dropSessionUser } from './helpers/session'
import { LARK_TEST_CONFIG as CONFIG, dropLarkSettings } from './helpers/lark'

const URL = 'http://localhost/api/design-agent/settings/lark'
const ADMIN_EMAIL = 'lark-notify-admin@test.local'
let adminCookie = ''
const adminRequest = (url: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cookie', adminCookie)
  return new NextRequest(url, { ...init, headers })
}

const lark = {
  reply: vi.fn(async () => {}),
  sendToChat: vi.fn<(chatId: string, text: string, mention?: string) => Promise<void>>(async () => {}),
  botOpenId: vi.fn(async () => 'ou_bot'),
  userName: vi.fn(async () => null),
}
const notice = { jobId: 'j1', taskKey: 'LIN1_1', kind: 'FIX' as const, reason: 'NEEDS_OWNER' as const, summary: '3 vòng chưa đạt: nền hai mảnh lệch màu' }
const realFetch = globalThis.fetch

beforeAll(async () => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  await dropLarkSettings()
  const row = await prisma.appUser.upsert({
    where: { email: ADMIN_EMAIL }, create: { name: 'Lark admin', email: ADMIN_EMAIL, role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) }, update: {},
  })
  adminCookie = `${AUTH_COOKIE}=${await signToken({ userId: row.id, email: ADMIN_EMAIL, name: 'Lark admin', role: 'ADMIN', permissions: DEFAULT_ROLE_PERMISSIONS.ADMIN, tv: row.tokenVersion })}`
})

afterAll(async () => {
  globalThis.fetch = realFetch
  resetLarkCache()
  await dropLarkSettings()
  await prisma.appUser.deleteMany({ where: { email: ADMIN_EMAIL } })
  await dropSessionUser()
})

beforeEach(() => { lark.sendToChat.mockClear(); lark.sendToChat.mockImplementation(async () => {}) })

describe('owner notice in the Lark group', () => {
  it('says nothing while Lark is off or half-configured', async () => {
    await notifyNeedsOwner(notice, { lark }); expect(lark.sendToChat).not.toHaveBeenCalled()
    await saveLarkConfig({ ...CONFIG, enabled: false })
    await notifyNeedsOwner(notice, { lark }); expect(lark.sendToChat).not.toHaveBeenCalled()
  })

  it('mentions the owner in the group', async () => {
    await saveLarkConfig({ ...CONFIG, enabled: true })
    await notifyNeedsOwner(notice, { lark })
    expect(lark.sendToChat).toHaveBeenCalledWith('oc_group', 'Agent cần chủ shop — LIN1_1: 3 vòng chưa đạt: nền hai mảnh lệch màu', 'ou_owner')
    await notifyNeedsOwner({ ...notice, reason: 'FAILED', summary: 'runner lost' }, { lark })
    expect(lark.sendToChat).toHaveBeenLastCalledWith('oc_group', 'Agent không chạy được — LIN1_1: runner lost', 'ou_owner')
    await notifyNeedsOwner({ ...notice, taskKey: null, summary: 'x'.repeat(400) }, { lark })
    expect(lark.sendToChat).toHaveBeenLastCalledWith('oc_group', `Agent cần chủ shop — job j1: ${'x'.repeat(300)}`, 'ou_owner')
  })

  it('without an owner open id the message goes out without a mention', async () => {
    await saveLarkConfig({ ownerOpenId: '' })
    await notifyNeedsOwner(notice, { lark })
    expect(lark.sendToChat).toHaveBeenLastCalledWith('oc_group', 'Agent cần chủ shop — LIN1_1: 3 vòng chưa đạt: nền hai mảnh lệch màu', undefined)
    await saveLarkConfig({ ownerOpenId: CONFIG.ownerOpenId })
  })

  it('a Lark failure never reaches the caller', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    lark.sendToChat.mockRejectedValueOnce(new LarkApiError('Lark /messages: 99991663 token invalid'))
    await expect(notifyNeedsOwner(notice, { lark })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledWith('[lark] chưa báo được chủ shop', 'Lark /messages: 99991663 token invalid')
    err.mockRestore()
  })

  it('the test message: works with the bot off, answers 502 when Lark refuses', async () => {
    await saveLarkConfig({ enabled: false })
    const sent: { url: string; body: any }[] = []
    let refuse = false
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const path = new globalThis.URL(url).pathname
      sent.push({ url, body: init.body ? JSON.parse(init.body as string) : null })
      if (path.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't-notify', expire: 7200 })
      return refuse ? Response.json({ code: 230002, msg: 'bot not in chat' }, { status: 400 }) : Response.json({ code: 0 })
    }) as unknown as typeof fetch
    resetLarkCache()
    const ok = await PUT(await superRequest(URL, { method: 'PUT' }))
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true })
    const msg = sent.find(s => s.url.includes('/im/v1/messages'))!
    expect(msg.url).toBe('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id')
    expect(msg.body).toMatchObject({ receive_id: 'oc_group', msg_type: 'text' })
    expect(JSON.parse(msg.body.content).text).toBe('Ecom Manager: bot Design Agent đã kết nối với nhóm này.')
    refuse = true
    const bad = await PUT(await superRequest(URL, { method: 'PUT' }))
    expect(bad.status).toBe(502)
    const text = await bad.text()
    expect(JSON.parse(text).error).toContain('230002')
    for (const secret of [CONFIG.appSecret, 't-notify', CONFIG.verificationToken]) expect(text).not.toContain(secret)
    globalThis.fetch = realFetch
  })

  it('the test message needs a full configuration and a Superadmin', async () => {
    expect((await PUT(adminRequest(URL, { method: 'PUT' }))).status).toBe(403)
    await prisma.appSetting.deleteMany({ where: { key: 'lark.chatId' } })
    const res = await PUT(await superRequest(URL, { method: 'PUT' }))
    expect(res.status).toBe(400); expect((await res.json()).error).toBe('Chưa cấu hình đủ Lark')
  })
})
