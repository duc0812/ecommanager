import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { GET as listCases, POST as createCase } from '@/app/api/cs/cases/route'
import { PATCH as patchCase, DELETE as deleteCase } from '@/app/api/cs/cases/[id]/route'
import { POST as promote } from '@/app/api/cs/cases/promote/route'

let token = ''
let userId = ''

function req(url: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', cookie: `${AUTH_COOKIE}=${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.csCase.deleteMany({})
  await prisma.csTicket.deleteMany({})
  const u = await prisma.appUser.upsert({ where: { email: 'cs-case@test.local' }, update: {}, create: { name: 'CS Tester', email: 'cs-case@test.local', role: 'SUPPORT', permissions: JSON.stringify(['cs']) } })
  userId = u.id
  token = await signToken({ userId, email: u.email, name: u.name, role: 'SUPPORT', permissions: ['cs'], tv: 0 })
})
afterAll(async () => {
  await prisma.csCase.deleteMany({})
  await prisma.csTicket.deleteMany({})
  await prisma.appUser.deleteMany({ where: { email: 'cs-case@test.local' } })
})

describe('/api/cs/cases', () => {
  it('creates, lists, patches and deletes a case', async () => {
    const created = await createCase(req('/api/cs/cases', { method: 'POST', body: { title: 'Late parcel', category: 'ORDER_STATUS', situation: 'late', resolution: 'apologise' } }))
    expect(created.status).toBe(200)
    const { case: c } = await created.json()
    expect(c.createdById).toBe(userId)
    expect(c.active).toBe(true)

    const listed = await (await listCases()).json()
    expect(listed.cases.map((x: any) => x.id)).toEqual([c.id])

    const patched = await patchCase(req(`/api/cs/cases/${c.id}`, { method: 'PATCH', body: { active: false, forbidden: 'never promise a refund' } }), { params: { id: c.id } })
    expect((await patched.json()).case.active).toBe(false)
    expect((await prisma.csCase.findUnique({ where: { id: c.id } }))!.forbidden).toBe('never promise a refund')

    const forbidden = await deleteCase(req(`/api/cs/cases/${c.id}`, { method: 'DELETE' }), { params: { id: c.id } })
    expect(forbidden.status).toBe(403)
    expect(await prisma.csCase.count()).toBe(1)
    await prisma.csCase.delete({ where: { id: c.id } })
  })

  it('rejects a case with an unknown category or missing fields', async () => {
    const bad = await createCase(req('/api/cs/cases', { method: 'POST', body: { title: 'x', category: 'NOPE', situation: 's', resolution: 'r' } }))
    expect(bad.status).toBe(400)
    const missing = await createCase(req('/api/cs/cases', { method: 'POST', body: { title: 'x', category: 'OTHER' } }))
    expect(missing.status).toBe(400)
  })

  it('promote builds an inactive PROMOTED draft from a ticket and a reply', async () => {
    const t = await prisma.csTicket.create({ data: { fdTicketId: 501, subject: 'Wrong colour', fdStatus: 2, fdPriority: 1, category: 'WRONG_ITEM', fdCreatedAt: new Date(), fdUpdatedAt: new Date() } })
    await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: 'pr-1', author: 'CUSTOMER', bodyText: 'The shirt is blue, I ordered red', createdAt: new Date() } })
    await prisma.csAnalysis.create({ data: { ticketId: t.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'CALM', summary: 'Khách nhận sai màu', proposal: 'In lại màu đỏ', needsHuman: true } })
    const res = await promote(req('/api/cs/cases/promote', { method: 'POST', body: { ticketId: t.id, replyBody: 'So sorry — we are remaking it in red right away.' } }))
    expect(res.status).toBe(200)
    const { case: c } = await res.json()
    expect(c.source).toBe('PROMOTED')
    expect(c.active).toBe(false)
    expect(c.category).toBe('WRONG_ITEM')
    expect(c.promotedFromTicketId).toBe(t.id)
    expect(c.situation).toContain('I ordered red')
    expect(c.exampleReply).toContain('remaking it in red')
    expect(c.title).toBe('Wrong colour')
  })
})
