import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as listUsers, POST as saveUser } from '@/app/api/users/route'
import { PATCH as patchUser } from '@/app/api/users/[id]/route'
import { GET as listStores } from '@/app/api/stores/route'
import { dropSessionUser, superRequest } from './helpers/session'

const P = 'usa'
const STORE_1 = `${P}-store-1`
const STORE_2 = `${P}-store-2`
const EMAILS = ['seller', 'admin', 'new', 'viewer'].map(k => `${P}-${k}@test.local`)
const [SELLER, ADMIN, NEW_SELLER, VIEWER] = EMAILS

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const patch = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function userId(email: string) {
  return (await prisma.appUser.findUniqueOrThrow({ where: { email }, select: { id: true } })).id
}

async function storesOf(email: string) {
  const rows = await prisma.userStoreAccess.findMany({ where: { user: { email } }, select: { storeId: true } })
  return rows.map(r => r.storeId).sort()
}

async function patchAs(email: string, body: unknown) {
  const id = await userId(email)
  const res = await patchUser(await superRequest(`http://localhost/api/users/${id}`, patch(body)), { params: { id } })
  return { status: res.status, body: await res.json() }
}

async function saveAs(body: unknown) {
  const res = await saveUser(await superRequest('http://localhost/api/users', json(body)))
  return { status: res.status, body: await res.json() }
}

beforeAll(async () => {
  process.env.AUTH_SECRET ||= 'test-secret-that-is-long-enough-32chars'
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [STORE_1, STORE_2] } } })
  await prisma.shopifyStore.create({ data: { id: STORE_1, shop: `${P}-1.myshopify.com` } })
  await prisma.shopifyStore.create({ data: { id: STORE_2, shop: `${P}-2.myshopify.com` } })
})

beforeEach(async () => {
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.appUser.create({
    data: { name: 'Seller', email: SELLER, role: 'SELLER', permissions: '["projects"]', storeAccess: { create: [{ storeId: STORE_1 }] } },
  })
  await prisma.appUser.create({ data: { name: 'Admin', email: ADMIN, role: 'ADMIN', permissions: '[]' } })
})

afterAll(async () => {
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [STORE_1, STORE_2] } } })
  await dropSessionUser()
})

describe('GET /api/users', () => {
  it('GET returns storeIds', async () => {
    await prisma.userStoreAccess.create({ data: { userId: await userId(SELLER), storeId: STORE_2 } })
    const res = await listUsers(await superRequest('http://localhost/api/users'))
    const rows = (await res.json()) as any[]
    const seller = rows.find(u => u.email === SELLER)
    const admin = rows.find(u => u.email === ADMIN)
    expect([...seller.storeIds].sort()).toEqual([STORE_1, STORE_2])
    expect(admin.storeIds).toEqual([])
  })

  it('does not hand out the join rows or a password hash', async () => {
    const rows = (await (await listUsers(await superRequest('http://localhost/api/users'))).json()) as any[]
    const seller = rows.find(u => u.email === SELLER)
    expect(seller).not.toHaveProperty('storeAccess')
    expect(seller).not.toHaveProperty('passwordHash')
  })
})

describe('PATCH /api/users/:id with storeIds', () => {
  it('PATCH /api/users/<id> with storeIds replaces the seller\'s access', async () => {
    const { status, body } = await patchAs(SELLER, { storeIds: [STORE_2] })
    expect(status).toBe(200)
    expect(body.storeIds).toEqual([STORE_2])
    expect(await storesOf(SELLER)).toEqual([STORE_2])

    expect((await patchAs(SELLER, { storeIds: [STORE_1, STORE_2] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([STORE_1, STORE_2])
  })

  it('an empty list takes every store away', async () => {
    expect((await patchAs(SELLER, { storeIds: [] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([])
  })

  it('a storeId that does not exist is 400 and changes nothing', async () => {
    const { status, body } = await patchAs(SELLER, { storeIds: [STORE_2, `${P}-no-such-store`] })
    expect(status).toBe(400)
    expect(body.error).toContain(`${P}-no-such-store`)
    expect(await storesOf(SELLER)).toEqual([STORE_1])
  })

  it('a storeIds that is not a list of ids is 400', async () => {
    for (const bad of ['usa-store-1', { a: 1 }, [1], [''], [null]]) {
      expect([bad, (await patchAs(SELLER, { storeIds: bad })).status]).toEqual([bad, 400])
    }
    expect(await storesOf(SELLER)).toEqual([STORE_1])
  })

  it('the same id twice counts once', async () => {
    expect((await patchAs(SELLER, { storeIds: [STORE_2, STORE_2] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([STORE_2])
  })

  it('stores can be given to a seller only', async () => {
    const refused = await patchAs(ADMIN, { storeIds: [STORE_1] })
    expect(refused.status).toBe(400)
    expect(await storesOf(ADMIN)).toEqual([])
    expect((await patchAs(ADMIN, { storeIds: [] })).status).toBe(200)
  })

  it('a seller whose stores change sees the new stores on its next call', async () => {
    const row = await prisma.appUser.findUniqueOrThrow({ where: { email: SELLER } })
    const token = await signToken({ userId: row.id, email: SELLER, name: 'Seller', role: 'SELLER', permissions: ['projects'], tv: row.tokenVersion })
    const asSeller = () => new NextRequest('http://localhost/api/stores', { headers: { cookie: `${AUTH_COOKIE}=${token}` } })
    const ids = async () => ((await (await listStores(asSeller())).json()).stores as { id: string }[]).map(s => s.id).sort()
    expect(await ids()).toEqual([STORE_1])
    await patchAs(SELLER, { storeIds: [STORE_2] })
    expect(await ids()).toEqual([STORE_2])
  })

  it('the password route keeps working: a password alone, and still at least ten characters', async () => {
    const before = await prisma.appUser.findUniqueOrThrow({ where: { email: SELLER } })
    expect((await patchAs(SELLER, { password: 'short' })).status).toBe(400)
    expect((await patchAs(SELLER, {})).status).toBe(400)
    expect((await patchAs(SELLER, { password: 'a-long-enough-password' })).status).toBe(200)
    const after = await prisma.appUser.findUniqueOrThrow({ where: { email: SELLER } })
    expect(await bcrypt.compare('a-long-enough-password', after.passwordHash ?? '')).toBe(true)
    expect(after.tokenVersion).toBe(before.tokenVersion + 1)
    expect(await storesOf(SELLER)).toEqual([STORE_1])
  })

  it('a bad password refuses the stores sent with it', async () => {
    expect((await patchAs(SELLER, { password: 'short', storeIds: [STORE_2] })).status).toBe(400)
    expect(await storesOf(SELLER)).toEqual([STORE_1])
  })

  it('a seller cannot change anyone\'s stores', async () => {
    const row = await prisma.appUser.findUniqueOrThrow({ where: { email: SELLER } })
    const token = await signToken({ userId: row.id, email: SELLER, name: 'Seller', role: 'SELLER', permissions: ['projects'], tv: row.tokenVersion })
    const req = new NextRequest(`http://localhost/api/users/${row.id}`, { ...patch({ storeIds: [STORE_1, STORE_2] }), headers: { cookie: `${AUTH_COOKIE}=${token}`, 'content-type': 'application/json' } })
    expect((await patchUser(req, { params: { id: row.id } })).status).toBe(403)
    expect(await storesOf(SELLER)).toEqual([STORE_1])
  })
})

describe('POST /api/users with storeIds', () => {
  it('creates a seller with its stores', async () => {
    const { status, body } = await saveAs({ name: 'New', email: NEW_SELLER, role: 'SELLER', permissions: ['projects'], storeIds: [STORE_2] })
    expect(status).toBe(200)
    expect(body.storeIds).toEqual([STORE_2])
    expect(await storesOf(NEW_SELLER)).toEqual([STORE_2])
  })

  it('saving an existing seller replaces its stores, and leaves them alone when storeIds is not sent', async () => {
    expect((await saveAs({ name: 'Seller', email: SELLER, role: 'SELLER', permissions: ['projects'], storeIds: [STORE_1, STORE_2] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([STORE_1, STORE_2])
    expect((await saveAs({ name: 'Seller 2', email: SELLER, role: 'SELLER', permissions: ['projects'] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([STORE_1, STORE_2])
  })

  it('a storeId that does not exist is 400 and creates nothing', async () => {
    const { status } = await saveAs({ name: 'New', email: NEW_SELLER, role: 'SELLER', storeIds: [`${P}-no-such-store`] })
    expect(status).toBe(400)
    expect(await prisma.appUser.count({ where: { email: NEW_SELLER } })).toBe(0)
  })

  it('stores sent for a role that is not Seller are refused', async () => {
    const { status } = await saveAs({ name: 'New', email: NEW_SELLER, role: 'SUPPORT', storeIds: [STORE_1] })
    expect(status).toBe(400)
    expect(await prisma.appUser.count({ where: { email: NEW_SELLER } })).toBe(0)
  })

  it('a seller changed to another role keeps no stores', async () => {
    expect((await saveAs({ name: 'Seller', email: SELLER, role: 'SUPPORT', permissions: ['cs'] })).status).toBe(200)
    expect(await storesOf(SELLER)).toEqual([])
    const rows = (await (await listUsers(await superRequest('http://localhost/api/users'))).json()) as any[]
    expect(rows.find(u => u.email === SELLER).storeIds).toEqual([])
  })

  it('a seller created without storeIds has no store yet', async () => {
    const { status, body } = await saveAs({ name: 'Viewer', email: VIEWER, role: 'SELLER', permissions: ['projects'] })
    expect(status).toBe(200)
    expect(body.storeIds).toEqual([])
  })
})
