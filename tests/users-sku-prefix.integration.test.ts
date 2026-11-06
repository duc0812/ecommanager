import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { GET as listUsers, POST as saveUser } from '@/app/api/users/route'
import { PATCH as patchUser } from '@/app/api/users/[id]/route'
import { dropSessionUser, superRequest } from './helpers/session'

const P = 'usp'
const SELLER = `${P}-seller@test.local`
const OTHER = `${P}-other@test.local`
const NEW = `${P}-new@test.local`
const EMAILS = [SELLER, OTHER, NEW]
const SESSION_EMAIL = 'session-helper-super@test.local'
const TAKEN_MESSAGE = 'Mã SKU này đã thuộc tài khoản khác.'
const FORMAT_MESSAGE = 'Mã SKU phải là 2 chữ cái A–Z.'

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function save(body: Record<string, unknown>) {
  const res = await saveUser(await superRequest('http://localhost/api/users', json('POST', { name: 'Seller', email: SELLER, role: 'SELLER', ...body })))
  return { status: res.status, body: await res.json() }
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await patchUser(await superRequest(`http://localhost/api/users/${id}`, json('PATCH', body)), { params: { id } })
  return { status: res.status, body: await res.json() }
}

const row = (email: string) => prisma.appUser.findUniqueOrThrow({ where: { email } })

beforeAll(() => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
})

beforeEach(async () => {
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.appUser.create({ data: { name: 'Seller', email: SELLER, role: 'SELLER', permissions: '["projects"]' } })
  await prisma.appUser.create({ data: { name: 'Other', email: OTHER, role: 'SELLER', permissions: '["projects"]', skuPrefix: 'ZZ' } })
  await prisma.appUser.updateMany({ where: { email: SESSION_EMAIL }, data: { skuPrefix: null } })
})

afterAll(async () => {
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await dropSessionUser()
})

describe('POST /api/users skuPrefix', () => {
  it('saves the prefix upper-cased and returns it', async () => {
    const res = await save({ skuPrefix: ' dc ' })
    expect(res.status).toBe(200)
    expect(res.body.skuPrefix).toBe('DC')
    expect((await row(SELLER)).skuPrefix).toBe('DC')
  })

  it('gives a new user the prefix too', async () => {
    const res = await saveUser(await superRequest('http://localhost/api/users', json('POST', { name: 'New', email: NEW, role: 'SELLER', skuPrefix: 'nw' })))
    expect(res.status).toBe(200)
    expect((await row(NEW)).skuPrefix).toBe('NW')
  })

  it('rejects a prefix that is not two letters (400) and saves nothing', async () => {
    for (const bad of ['D1', 'DCA', 'D', ' ', 7]) {
      const res = await save({ name: 'Changed', skuPrefix: bad })
      expect(res.status, String(bad)).toBe(400)
      expect(res.body.error).toBe(FORMAT_MESSAGE)
    }
    const seller = await row(SELLER)
    expect(seller.skuPrefix).toBeNull()
    expect(seller.name).toBe('Seller')
  })

  it('rejects a prefix another user holds (409), however it is written', async () => {
    for (const taken of ['ZZ', 'zz', ' Zz ']) {
      const res = await save({ skuPrefix: taken })
      expect(res.status, taken).toBe(409)
      expect(res.body.error).toBe(TAKEN_MESSAGE)
    }
    expect((await row(SELLER)).skuPrefix).toBeNull()
  })

  it('lets a user keep their own prefix when the form is saved again', async () => {
    await save({ skuPrefix: 'DC' })
    const res = await save({ skuPrefix: 'dc' })
    expect(res.status).toBe(200)
    expect(res.body.skuPrefix).toBe('DC')
  })

  it('leaves the prefix alone when the body has none, and clears it on an empty string', async () => {
    await save({ skuPrefix: 'DC' })
    expect((await save({ name: 'Renamed' })).body.skuPrefix).toBe('DC')
    expect((await row(SELLER)).skuPrefix).toBe('DC')
    const cleared = await save({ skuPrefix: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.skuPrefix).toBeNull()
    expect((await row(SELLER)).skuPrefix).toBeNull()
  })

  it('does not sign the user out when only the prefix changes', async () => {
    const before = (await row(SELLER)).tokenVersion
    await save({ permissions: ['projects'], skuPrefix: 'DC' })
    expect((await row(SELLER)).tokenVersion).toBe(before)
  })
})

describe('GET /api/users skuPrefix', () => {
  it('returns each user with their prefix', async () => {
    const res = await listUsers(await superRequest('http://localhost/api/users'))
    const rows = (await res.json()) as { email: string; skuPrefix: string | null }[]
    expect(rows.find(u => u.email === OTHER)?.skuPrefix).toBe('ZZ')
    expect(rows.find(u => u.email === SELLER)?.skuPrefix).toBeNull()
  })
})

describe('PATCH /api/users/[id] skuPrefix', () => {
  it('lets the Super Admin set the prefix on their own account', async () => {
    const me = await row(SESSION_EMAIL)
    const res = await patch(me.id, { skuPrefix: ' ow ' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, skuPrefix: 'OW' })
    const after = await row(SESSION_EMAIL)
    expect(after.skuPrefix).toBe('OW')
    expect(after.tokenVersion).toBe(me.tokenVersion)
    expect(after.passwordHash).toBeNull()
  })

  it('clears the prefix on an empty string', async () => {
    const me = await row(SESSION_EMAIL)
    await patch(me.id, { skuPrefix: 'OW' })
    const res = await patch(me.id, { skuPrefix: '' })
    expect(res.status).toBe(200)
    expect(res.body.skuPrefix).toBeNull()
    expect((await row(SESSION_EMAIL)).skuPrefix).toBeNull()
  })

  it('rejects a wrong shape (400) and a prefix another user holds (409)', async () => {
    const me = await row(SESSION_EMAIL)
    const bad = await patch(me.id, { skuPrefix: 'D1' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe(FORMAT_MESSAGE)
    const taken = await patch(me.id, { skuPrefix: 'zz' })
    expect(taken.status).toBe(409)
    expect(taken.body.error).toBe(TAKEN_MESSAGE)
    expect((await row(SESSION_EMAIL)).skuPrefix).toBeNull()
  })

  it('works on a seller too, and still asks for a password when it is the only field', async () => {
    const seller = await row(SELLER)
    const ok = await patch(seller.id, { skuPrefix: 'SL' })
    expect(ok.status).toBe(200)
    expect((await row(SELLER)).skuPrefix).toBe('SL')
    const none = await patch(seller.id, {})
    expect(none.status).toBe(400)
  })

  it('answers 404 for a user that does not exist', async () => {
    expect((await patch('usp-missing', { skuPrefix: 'SL' })).status).toBe(404)
  })
})
