import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { getLarkConfig, getLarkStatus, saveLarkConfig } from '@/lib/lark/settings'
import { GET, POST } from '@/app/api/design-agent/settings/lark/route'
import { superRequest, dropSessionUser } from './helpers/session'

const URL = 'http://localhost/api/design-agent/settings/lark'
const ADMIN_EMAIL = 'lark-settings-admin@test.local'
let adminCookie = ''

const json = (body: unknown): ConstructorParameters<typeof NextRequest>[1] => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const adminRequest = (url: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cookie', adminCookie)
  return new NextRequest(url, { ...init, headers })
}
const dropLark = () => prisma.appSetting.deleteMany({ where: { key: { startsWith: 'lark.' } } })

beforeAll(async () => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  await dropLark()
  const row = await prisma.appUser.upsert({
    where: { email: ADMIN_EMAIL }, create: { name: 'Lark admin', email: ADMIN_EMAIL, role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) }, update: {},
  })
  const token = await signToken({ userId: row.id, email: ADMIN_EMAIL, name: 'Lark admin', role: 'ADMIN', permissions: DEFAULT_ROLE_PERMISSIONS.ADMIN, tv: row.tokenVersion })
  adminCookie = `${AUTH_COOKIE}=${token}`
})

afterAll(async () => {
  await dropLark()
  await prisma.appUser.deleteMany({ where: { email: ADMIN_EMAIL } })
  await dropSessionUser()
})

describe('Lark settings', () => {
  it('nothing configured: off, not configured, no secret', async () => {
    expect(await getLarkStatus()).toMatchObject({ enabled: false, configured: false, hasAppSecret: false, appSecretMasked: null })
  })

  it('GET returns masked values only', async () => {
    await saveLarkConfig({ appId: 'cli_a1', appSecret: 'secret-lark-marker-9911', verificationToken: 'vt-lark-marker-7722', encryptKey: 'ek-lark-marker-5533', chatId: 'oc_group', ownerOpenId: 'ou_owner' })
    const res = await GET(await superRequest(URL))
    const text = await res.text()
    for (const secret of ['secret-lark-marker-9911', 'vt-lark-marker-7722', 'ek-lark-marker-5533']) expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ configured: true, appId: 'cli_a1', chatId: 'oc_group', hasAppSecret: true, appSecretMasked: 'secr…9911', hasEncryptKey: true })
  })

  it('a blank secret keeps the stored one; "-" clears the encrypt key', async () => {
    await saveLarkConfig({ appSecret: '', chatId: 'oc_group2', encryptKey: '-' })
    expect(await getLarkConfig()).toMatchObject({ appSecret: 'secret-lark-marker-9911', chatId: 'oc_group2', encryptKey: '' })
  })

  it('POST saves, trims and answers the masked status', async () => {
    const res = await POST(await superRequest(URL, json({ chatId: '  oc_group3 ', appSecret: '', enabled: true })))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('secret-lark-marker-9911')
    expect(JSON.parse(text)).toMatchObject({ enabled: true, configured: true, chatId: 'oc_group3' })
    await saveLarkConfig({ enabled: false })
  })

  it('cannot be turned on half-configured; only a Superadmin reaches the route', async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'lark.chatId' } })
    const refused = await POST(await superRequest(URL, json({ enabled: true })))
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toBe('Điền App ID, App Secret, Verification Token và Chat ID trước khi bật')
    expect((await getLarkConfig()).enabled).toBe(false)
    expect((await GET(adminRequest(URL))).status).toBe(403)
    expect((await POST(adminRequest(URL, json({ enabled: false })))).status).toBe(403)
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings/lark', 'GET')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings', 'GET')).toBe(
      DEFAULT_ROLE_PERMISSIONS.ADMIN.includes('design_tasks') ? 'ok' : 'forbidden',
    )
  })
})
