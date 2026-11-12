import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateAgentRunnerToken } from '@/lib/design-agent/runner'
import { GET as getSettings, PUT as putSettings } from '@/app/api/design-agent/settings/route'
import { POST as mintToken, DELETE as revokeToken } from '@/app/api/design-agent/settings/runner-token/route'
import { POST as backfill } from '@/app/api/design-agent/backfill/route'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dab')
let designer = ''
let admin = ''
let superadmin = ''

const KEYS = ['design.settings', 'design.agent.tokenHash', 'design.agent.lastSeenAt']

function req(path: string, method: string, cookie: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const asDesigner = (path: string) => req(path, 'GET', designer)
const asAdmin = (body?: unknown) => req('/api/design-agent/x', 'POST', admin, body ?? {})
const asSuper = (body?: unknown) => req('/api/design-agent/x', 'POST', superadmin, body ?? {})
const put = (cookie: string, body: unknown) => putSettings(req('/api/design-agent/settings', 'PUT', cookie, body))
const jobOf = (key: string) => prisma.designAgentJob.findFirstOrThrow({ where: { taskKey: key } })

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAB' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await fx.cleanup()
  await fx.seed()
  designer = (await fx.user('Des', 'SUPPORT', ['design_tasks'])).cookie
  admin = (await fx.user('Admin', 'ADMIN')).cookie
  superadmin = (await fx.user('Super', 'SUPERADMIN')).cookie
  await fx.order(1, { skus: ['DB1-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(2, { skus: ['DB2-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(3, { skus: ['DB3-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(4, { skus: ['DB4-Hoodie'], taskStatus: 'REJECTED', pipelineStatus: 'FULFILLED' })
  await fx.order(5, { skus: ['DB5-Hoodie'], taskStatus: 'REJECTED', fulfillmentStatus: 'fulfilled' })
  await fx.order(6, { skus: ['DB6-Hoodie'], taskStatus: 'DONE' })
  await prisma.designTask.update({ where: { taskKey: 'DAB1_1' }, data: { rejectReasons: JSON.stringify(['Sai chi tiết']), rejectNote: 'sao lệch' } })
  await prisma.designTask.update({ where: { taskKey: 'DAB2_1' }, data: { rejectReasons: JSON.stringify(['Xưởng trả file']) } })
  await prisma.designAgentJob.create({
    data: { kind: 'FIX', source: 'REJECT', taskId: (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAB3_1' } })).id, taskKey: 'DAB3_1', requestText: 'x' },
  })
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAB' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  await fx.cleanup()
})

describe('agent admin API', () => {
  it('GET shows switches, runner and queue; never the token', async () => {
    const token = await generateAgentRunnerToken()
    const res = await getSettings(asDesigner('/api/design-agent/settings'))
    expect(await res.clone().json()).toMatchObject({
      agent: { autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 }, runner: { configured: true, online: false }, queue: { queued: 1, running: 0 }, rejectedBacklog: 2,
    })
    expect(await res.text()).not.toContain(token.slice(4))
  })

  it('only a Superadmin changes settings or the token', async () => {
    expect((await put(admin, { autoFixOnReject: true })).status).toBe(403)
    expect((await put(superadmin, { maxConcurrent: 0 })).status).toBe(400)
    expect(await (await put(superadmin, { leaseMinutes: 4 })).json()).toEqual({ error: 'leaseMinutes phải là số nguyên từ 5 đến 120' })
    expect(await (await put(superadmin, { autoFixOnReject: 'on' })).json()).toEqual({ error: 'autoFixOnReject phải là true hoặc false' })
    expect(await (await put(superadmin, { maxConcurrent: 11 })).json()).toEqual({ error: 'maxConcurrent phải là số nguyên từ 1 đến 10' })
    expect(await (await put(superadmin, { autoFixOnReject: true, maxConcurrent: 3 })).json()).toEqual({ agent: { autoFixOnReject: true, maxConcurrent: 3, leaseMinutes: 20 } })
    expect(await (await put(superadmin, {})).json()).toEqual({ agent: { autoFixOnReject: true, maxConcurrent: 3, leaseMinutes: 20 } })
    expect((await put(designer, { autoFixOnReject: false })).status).toBe(403)
    expect((await mintToken(req('/api/design-agent/settings/runner-token', 'POST', admin))).status).toBe(403)
    const minted = await (await mintToken(req('/api/design-agent/settings/runner-token', 'POST', superadmin))).json()
    expect(minted.token).toMatch(/^dag_/)
    expect(minted).toMatchObject({ configured: true })
    expect((await revokeToken(req('/api/design-agent/settings/runner-token', 'DELETE', admin))).status).toBe(403)
    const revoked = await (await revokeToken(req('/api/design-agent/settings/runner-token', 'DELETE', superadmin))).json()
    expect(revoked.configured).toBe(false)
    expect(JSON.stringify(revoked)).not.toContain(minted.token.slice(4))
  })

  it('backfill is a dry run unless told otherwise, and skips tasks that already have a job or a closed order', async () => {
    expect(await (await backfill(asSuper({}))).json()).toEqual({ dryRun: true, count: 2, taskKeys: ['DAB1_1', 'DAB2_1'], queued: 0 })
    expect(await prisma.designAgentJob.count({ where: { source: 'BACKFILL' } })).toBe(0)
    expect((await backfill(asAdmin({ dryRun: false }))).status).toBe(403)
    expect((await (await backfill(asSuper({ dryRun: false }))).json()).queued).toBe(2)
    expect(await jobOf('DAB2_1')).toMatchObject({ kind: 'FIX', source: 'BACKFILL', priority: 10, requestText: 'Lý do: Xưởng trả file', requestedBy: 'Super' })
    expect(await jobOf('DAB1_1')).toMatchObject({ source: 'BACKFILL', priority: 0, requestText: 'Lý do: Sai chi tiết\nGhi chú: sao lệch' })
    expect(await (await backfill(asSuper({ dryRun: false }))).json()).toEqual({ dryRun: false, count: 0, taskKeys: [], queued: 0 })
  })
})
