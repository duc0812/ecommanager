import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { POST as postReopen } from '@/app/api/design-studio/lines/[lineId]/reopen/route'
import { POST as postTold } from '@/app/api/design-studio/tasks/[key]/supplier-told/route'

// Internal failures of the two write routes: the caller gets a fixed text, the real error goes to the server log.
vi.mock('@/lib/design-tasks', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/design-tasks')>()
  return {
    ...real,
    reopenLineForFix: vi.fn(async (lineId: string, actor: any, input: any) => {
      if (lineId === 'boom') throw new Error('SQLITE_BUSY: database is locked (secret path D:\\db)')
      return real.reopenLineForFix(lineId, actor, input)
    }),
    markSupplierTold: vi.fn(async (key: string, actor: any) => {
      if (key === 'BOOM_1') throw new Error('PrismaClientKnownRequestError: secret detail')
      return real.markSupplierTold(key, actor)
    }),
  }
})

const EMAIL = 't22e-admin@test.local'
let token = ''

function authed(url: string, body: unknown) {
  const req = new NextRequest(`http://x${url}`, { method: 'POST', body: JSON.stringify(body) })
  req.cookies.set(AUTH_COOKIE, token)
  return req
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.appUser.deleteMany({ where: { email: EMAIL } })
  const row = await prisma.appUser.create({ data: { name: 'admin', email: EMAIL, role: 'ADMIN', permissions: JSON.stringify(DEFAULT_ROLE_PERMISSIONS.ADMIN) } })
  token = await signToken({ userId: row.id, email: EMAIL, name: 'admin', role: 'ADMIN', permissions: DEFAULT_ROLE_PERMISSIONS.ADMIN, tv: row.tokenVersion })
})

afterAll(async () => {
  await prisma.appUser.deleteMany({ where: { email: EMAIL } })
})

describe('internal errors answer a fixed Vietnamese text', () => {
  it('"Mở lại để sửa": a 500 without the error text, logged on the server; its own refusals keep their message', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await postReopen(authed('/api/design-studio/lines/boom/reopen', { reason: 'Khách yêu cầu sửa', note: 'đổi tên' }), { params: { lineId: 'boom' } })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Không mở lại được dòng — thử lại sau' })
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[design studio] reopen line boom'), expect.objectContaining({ message: expect.stringContaining('secret path') }))

    const invalid = await postReopen(authed('/api/design-studio/lines/nope/reopen', { reason: 'Khách yêu cầu sửa' }), { params: { lineId: 'nope' } })
    expect([invalid.status, (await invalid.json()).error]).toEqual([400, 'Ghi "Cần sửa ở đâu" để designer biết chỗ cần sửa'])
    const missing = await postReopen(authed('/api/design-studio/lines/nope/reopen', { reason: 'Khách yêu cầu sửa', note: 'đổi tên' }), { params: { lineId: 'nope' } })
    expect([missing.status, (await missing.json()).error]).toEqual([404, 'Không tìm thấy dòng'])
    log.mockRestore()
  })

  it('"Đã báo xưởng": 404 for an unknown task, a 500 without the error text for anything else', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unknown = await postTold(authed('/api/design-studio/tasks/NOPE_1/supplier-told', {}), { params: { key: 'NOPE_1' } })
    expect([unknown.status, (await unknown.json()).error]).toEqual([404, 'Không tìm thấy task'])
    const res = await postTold(authed('/api/design-studio/tasks/BOOM_1/supplier-told', {}), { params: { key: 'BOOM_1' } })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Không ghi được "Đã báo xưởng" — thử lại sau' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[design studio] supplier told BOOM_1'), expect.objectContaining({ message: expect.stringContaining('secret detail') }))
    log.mockRestore()
  })
})
