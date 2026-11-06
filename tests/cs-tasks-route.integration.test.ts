import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { GET as listTasksRoute, POST as createTaskRoute } from '@/app/api/cs/tasks/route'
import { GET as taskRoute, PATCH as patchTaskRoute } from '@/app/api/cs/tasks/[id]/route'
import { POST as commentRoute } from '@/app/api/cs/tasks/[id]/comments/route'
import { POST as readRoute } from '@/app/api/cs/tickets/[id]/read/route'
import { listTickets, ticketDetail } from '@/lib/cs/queries'

let token = ''
const EMAIL = 'cs-task@test.local'

function req(url: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', cookie: `${AUTH_COOKIE}=${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

async function mkTicket(fdId: number) {
  return prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `route ${fdId}`, fdStatus: 2, fdPriority: 1, orderNumber: '#LIT9100', fdCreatedAt: new Date('2026-11-05T08:00:00Z'), fdUpdatedAt: new Date('2026-11-05T08:00:00Z'), lastCustomerAt: new Date('2026-11-05T08:00:00Z') } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.csTask.deleteMany({})
  await prisma.csTicket.deleteMany({})
  const u = await prisma.appUser.upsert({ where: { email: EMAIL }, update: {}, create: { name: 'Trang', email: EMAIL, role: 'SUPPORT', permissions: JSON.stringify(['cs']) } })
  token = await signToken({ userId: u.id, email: u.email, name: u.name, role: 'SUPPORT', permissions: ['cs'], tv: 0 })
})
afterAll(async () => {
  await prisma.csTask.deleteMany({})
  await prisma.csTicket.deleteMany({})
  await prisma.appUser.deleteMany({ where: { email: EMAIL } })
})

describe('read check', () => {
  it('an unread open ticket shows in the unread tab until staff mark it read', async () => {
    const t = await mkTicket(7101)
    expect((await listTickets('unread')).map(r => r.id)).toContain(t.id)
    expect((await listTickets('todo')).find(r => r.id === t.id)?.needsRead).toBe(true)
    const res = await readRoute(req(`/api/cs/tickets/${t.id}/read`, { method: 'POST' }), { params: { id: t.id } })
    expect(res.status).toBe(200)
    expect((await listTickets('unread')).map(r => r.id)).not.toContain(t.id)
    const d = await ticketDetail(t.id)
    expect(d!.ticket.staffReadByName).toBe('Trang')
    expect(d!.needsRead).toBe(false)
  })
  it('404 for a ticket that does not exist', async () => {
    const res = await readRoute(req('/api/cs/tickets/nope/read', { method: 'POST' }), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })
})

describe('/api/cs/tasks', () => {
  it('creates a task from a ticket, lists it, moves it with a note, comments, and shows the thread', async () => {
    const t = await mkTicket(7102)
    const created = await createTaskRoute(req('/api/cs/tasks', { method: 'POST', body: { ticketId: t.id, type: 'SIZE_CHANGE', detail: 'Đổi size L → XL' } }))
    expect(created.status).toBe(200)
    const { task } = await created.json()
    expect(task).toMatchObject({ type: 'SIZE_CHANGE', dept: 'FULFILLMENT', priority: 1, status: 'NEW', orderNumber: '#LIT9100', createdByName: 'Trang' })

    const list = await (await listTasksRoute(req('/api/cs/tasks?dept=FULFILLMENT'))).json()
    expect(list.tasks.map((x: any) => x.id)).toEqual([task.id])
    expect(list.tasks[0].ticket.fdTicketId).toBe(7102)

    const moved = await patchTaskRoute(req(`/api/cs/tasks/${task.id}`, { method: 'PATCH', body: { status: 'IN_PROGRESS', note: 'Đã báo xưởng' } }), { params: { id: task.id } })
    expect(moved.status).toBe(200)
    expect((await moved.json()).task.status).toBe('IN_PROGRESS')

    const c = await commentRoute(req(`/api/cs/tasks/${task.id}/comments`, { method: 'POST', body: { body: 'Xưởng hẹn mai đổi xong' } }), { params: { id: task.id } })
    expect(c.status).toBe(200)

    const d = await (await taskRoute(req(`/api/cs/tasks/${task.id}`), { params: { id: task.id } })).json()
    expect(d.events.map((e: any) => e.kind)).toEqual(['CREATED', 'STATUS', 'COMMENT'])
    expect((await ticketDetail(t.id))!.tasks.map(x => x.id)).toEqual([task.id])
  })
  it('rejects a bad type, a bad status and an empty comment with 400', async () => {
    const bad = await createTaskRoute(req('/api/cs/tasks', { method: 'POST', body: { type: 'NOPE', detail: 'x' } }))
    expect(bad.status).toBe(400)
    const ok = await (await createTaskRoute(req('/api/cs/tasks', { method: 'POST', body: { type: 'OTHER', detail: 'x', orderNumber: '#LIT1' } }))).json()
    const badStatus = await patchTaskRoute(req(`/api/cs/tasks/${ok.task.id}`, { method: 'PATCH', body: { status: 'LOST' } }), { params: { id: ok.task.id } })
    expect(badStatus.status).toBe(400)
    const empty = await commentRoute(req(`/api/cs/tasks/${ok.task.id}/comments`, { method: 'POST', body: { body: ' ' } }), { params: { id: ok.task.id } })
    expect(empty.status).toBe(400)
  })
  it('404 for a task that does not exist', async () => {
    const res = await taskRoute(req('/api/cs/tasks/nope'), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })
})
