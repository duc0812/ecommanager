import crypto from 'crypto'
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { loadTask } from '@/lib/design-tasks'
import { generateCloneWorkerToken } from '@/lib/clone/worker'
import { enqueueAgentJob } from '@/lib/design-agent/jobs'
import { AGENT_USER_EMAIL, ensureAgentUser } from '@/lib/design-agent/agent-user'
import {
  agentRunnerInfo, claimAgentJobs, claimAgentJobsWithWait, failAgentJob, generateAgentRunnerToken, heartbeatAgentJob, markAgentRunnerSeen,
  revokeAgentRunnerToken, verifyAgentRunnerRequest,
} from '@/lib/design-agent/runner'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dar')
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const req = (auth?: string) => new NextRequest('http://localhost/api/design-agent/runner/claim', { method: 'POST', headers: auth ? { authorization: auth } : {} })
const rowOf = (id: string) => prisma.designAgentJob.findUniqueOrThrow({ where: { id } })
const taskId = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).id
const MIN = 60_000

async function job(key: string, data: Record<string, unknown> = {}) {
  return prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId(key), taskKey: key, requestText: 'Lý do: Sai chi tiết', ...data } })
}

async function lastEvent(key: string) {
  const e = await prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: await taskId(key) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const actor = e.actorId ? await prisma.appUser.findUnique({ where: { id: e.actorId } }) : null
  return { type: e.type, message: e.message, actorName: actor?.name ?? null }
}

const waiterCount = () => globalThis.__designAgentQueueWaiters?.size ?? 0

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAR' } } })
  await fx.cleanup()
  await fx.seed()
  await fx.order(1, { taskStatus: 'REJECTED', withPrint: true })
  await fx.order(2, { taskStatus: 'DONE', exported: true, withPrint: true })
  for (const n of [3, 4, 5, 6]) await fx.order(n, { skus: [`DR${n}-Hoodie`] })
  await fx.order(7, { skus: ['DR7-Hoodie'], taskStatus: 'CANCELLED' })
  await fx.order(8, { skus: ['DR8-Hoodie'], taskStatus: 'DONE' })
})

beforeEach(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAR' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
})

afterEach(() => {
  expect(waiterCount()).toBe(0)
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAR' } } })
  await prisma.appSetting.deleteMany({ where: { key: { in: ['design.settings', 'design.agent.tokenHash', 'design.agent.lastSeenAt', 'clone.worker.tokenHash'] } } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await fx.cleanup()
})

describe('design agent runner core', () => {
  it('token: dag_ prefix, only the hash is stored, other tokens are refused', async () => {
    const token = await generateAgentRunnerToken()
    expect(token).toMatch(/^dag_[A-Za-z0-9_-]{43}$/)
    expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'design.agent.tokenHash' } })).value).toBe(sha256(token))
    expect(await verifyAgentRunnerRequest(req(`Bearer ${token}`))).toBe(true)
    expect(await verifyAgentRunnerRequest(req(`Bearer ${await generateCloneWorkerToken()}`))).toBe(false)
    expect(await verifyAgentRunnerRequest(req())).toBe(false)
    await markAgentRunnerSeen()
    expect(await agentRunnerInfo()).toMatchObject({ configured: true, online: true })
    await markAgentRunnerSeen(new Date(Date.now() - 2 * MIN))
    expect((await agentRunnerInfo()).online).toBe(false)
    await revokeAgentRunnerToken()
    expect(await verifyAgentRunnerRequest(req(`Bearer ${token}`))).toBe(false)
    expect(await agentRunnerInfo()).toMatchObject({ configured: false, tokenUpdatedAt: null })
  })

  it('claims factory jobs first, then the oldest, within maxConcurrent', async () => {
    await saveAgentSettings({ maxConcurrent: 2 })
    const A = (await job('DAR3_1', { createdAt: new Date(Date.now() - 3 * MIN) })).id
    const B = (await job('DAR4_1', { priority: 10, createdAt: new Date(Date.now() - 1 * MIN) })).id
    await job('DAR5_1', { createdAt: new Date(Date.now() - 2 * MIN) })
    expect((await claimAgentJobs(5)).map(j => j.id)).toEqual([B, A])
    expect(await claimAgentJobs(5)).toEqual([])
    expect(await claimAgentJobs(0)).toEqual([])
    expect(await rowOf(A)).toMatchObject({ status: 'RUNNING', attempts: 1 })
  })

  it('a second job of a task already running is skipped this round', async () => {
    await job('DAR3_1', { status: 'RUNNING', attempts: 1, lockedAt: new Date() })
    const other = (await job('DAR3_1', { kind: 'MOCKUP' })).id
    expect(await claimAgentJobs(5)).toEqual([])
    expect((await rowOf(other)).status).toBe('QUEUED')
  })

  it('the claim carries the context of the contract', async () => {
    await job('DAR1_1', { requestedBy: 'Huong' })
    const [claim] = await claimAgentJobs(1)
    expect(claim).toMatchObject({
      kind: 'FIX', source: 'REJECT', attempts: 1, priority: 0, requestedBy: 'Huong', parent: null,
      task: { key: 'DAR1_1', status: 'REJECTED', orderNumber: '#DAR1', linePosition: 1, sku: 'DN1-Hoodie', designCode: 'DN1', sent: false, customFields: { Name: 'X' } },
      files: [{ kind: 'PRINT', printArea: 'PRINT', version: 1, url: expect.stringMatching(/^\/api\/design-agent\/runner\/files\//), driveUrl: null }],
      affected: [{ taskKey: 'DAR2_1', sent: true }],
    })
    expect(claim.files[0].url).toBe(`/api/design-agent/runner/files/${claim.files[0].id}`)
    expect(claim.events.length).toBeGreaterThan(0)
    expect(claim.events.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(claim)).not.toContain('dag_')
  })

  it('events: the last 20, oldest first', async () => {
    const id = await taskId('DAR1_1')
    const base = Date.now() - 60 * MIN
    for (let i = 0; i < 25; i++) await prisma.designTaskEvent.create({ data: { taskId: id, type: 'NOTE', message: `n${i}`, createdAt: new Date(base + i * 1000) } })
    await job('DAR1_1')
    const [claim] = await claimAgentJobs(1)
    expect(claim.events).toHaveLength(20)
    const at = claim.events.map(e => Date.parse(e.at))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it('a lost runner: requeued once, then FAILED "runner lost"', async () => {
    const id = (await job('DAR6_1', { status: 'RUNNING', attempts: 1, lockedAt: new Date(Date.now() - 21 * MIN), startedAt: new Date(Date.now() - 30 * MIN) })).id
    const [again] = await claimAgentJobs(1)
    expect(again).toMatchObject({ id, attempts: 2 })
    await prisma.designAgentJob.update({ where: { id }, data: { lockedAt: new Date(Date.now() - 21 * MIN) } })
    expect(await claimAgentJobs(1)).toEqual([])
    expect(await rowOf(id)).toMatchObject({ status: 'FAILED', error: 'runner lost' })
  })

  it('nothing is handed out for a cancelled or already approved task', async () => {
    const cancelledTaskJob = (await job('DAR7_1')).id
    const approvedTaskJob = (await job('DAR8_1')).id
    expect(await claimAgentJobs(5)).toEqual([])
    expect(await rowOf(cancelledTaskJob)).toMatchObject({ status: 'CANCELLED', error: 'Task đã huỷ' })
    expect(await rowOf(approvedTaskJob)).toMatchObject({ status: 'CANCELLED', error: 'Task đã được duyệt' })
  })

  it('heartbeat renews a running job only', async () => {
    const running = (await job('DAR3_1', { status: 'RUNNING', attempts: 1, lockedAt: new Date(Date.now() - 5 * MIN) })).id
    const queued = (await job('DAR4_1')).id
    expect(await heartbeatAgentJob(running, { stage: 'round 1: codex', rounds: 1 })).toBe(true)
    const row = await rowOf(running)
    expect(row).toMatchObject({ stage: 'round 1: codex', rounds: 1 })
    expect(row.lockedAt!.getTime()).toBeGreaterThan(Date.now() - MIN)
    expect(await heartbeatAgentJob(running, { stage: 'x'.repeat(500), rounds: -1 })).toBe(true)
    expect(await rowOf(running)).toMatchObject({ stage: 'x'.repeat(200), rounds: 1 })
    expect(await heartbeatAgentJob(queued, {})).toBe(false)
  })

  it('fail: back to the queue once, then FAILED with a note on the task', async () => {
    const id = (await job('DAR3_1')).id
    await claimAgentJobs(1)
    expect(await failAgentJob(id, { error: 'claude exited 1', permanent: false })).toEqual({ status: 'QUEUED', attempts: 1 })
    expect(await rowOf(id)).toMatchObject({ status: 'QUEUED', lockedAt: null })
    await claimAgentJobs(1)
    expect(await failAgentJob(id, { error: 'no result.json' })).toEqual({ status: 'FAILED', attempts: 2 })
    expect(await lastEvent('DAR3_1')).toMatchObject({ type: 'NOTE', message: 'Agent: không chạy được — no result.json', actorName: 'Design Agent' })
    const queued = (await job('DAR4_1')).id
    expect(await failAgentJob(queued, { error: 'x' })).toBeNull()
    const permanent = (await job('DAR5_1')).id
    await claimAgentJobs(5)
    expect(await failAgentJob(permanent, { error: 'không có template', permanent: true })).toEqual({ status: 'FAILED', attempts: 1 })
  })

  it('the long poll returns when a job arrives', async () => {
    const started = Date.now()
    setTimeout(() => { void enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAR3_1', requestText: 'x' }) }, 50)
    const claims = await claimAgentJobsWithWait(1, 5)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(claims.map(c => c.task.key)).toEqual(['DAR3_1'])
  })

  it('the long poll claims nothing after an abort', async () => {
    const client = new AbortController()
    let created = ''
    setTimeout(() => {
      void enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAR4_1', requestText: 'x' }).then(r => { created = r.job.id; client.abort() })
    }, 100)
    const started = Date.now()
    expect(await claimAgentJobsWithWait(1, 5, client.signal)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1500)
    expect(created).not.toBe('')
    expect(await rowOf(created)).toMatchObject({ status: 'QUEUED', attempts: 0 })
    const gone = new AbortController()
    gone.abort()
    expect(await claimAgentJobsWithWait(1, 5, gone.signal)).toEqual([])
    expect((await rowOf(created)).status).toBe('QUEUED')
  })

  it('the long poll with no capacity waits the window out', async () => {
    await job('DAR3_1')
    const started = Date.now()
    expect(await claimAgentJobsWithWait(0, 0.3)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(await claimAgentJobsWithWait(1, 0)).toHaveLength(1)
  })

  it('ensureAgentUser is one inactive Support user without a password, not offered in "Giao việc"', async () => {
    const a = await ensureAgentUser()
    expect((await ensureAgentUser()).id).toBe(a.id)
    expect(a).toEqual({ id: a.id, name: 'Design Agent', role: 'SUPPORT', permissions: ['design_tasks'] })
    expect(await prisma.appUser.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ role: 'SUPPORT', permissions: '["design_tasks"]', status: 'INACTIVE', passwordHash: null })
    expect((await loadTask('DAR1_1'))!.assignable.some(u => u.id === a.id)).toBe(false)
  })
})
