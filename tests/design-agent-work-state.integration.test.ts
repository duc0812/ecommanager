import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const lark = vi.hoisted(() => ({
  reply: vi.fn(async () => {}),
  sendToChat: vi.fn<(chatId: string, text: string, mention?: string) => Promise<void>>(async () => {}),
  botOpenId: vi.fn(async () => 'ou_bot'),
  userName: vi.fn(async () => null),
}))
vi.mock('@/lib/lark/api', async original => ({ ...(await original<typeof import('@/lib/lark/api')>()), larkApi: () => lark }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { transitionTask, type Actor } from '@/lib/design-tasks'
import { AgentJobError, backfillRejected, enqueueAgentJob, enqueueFixOnReject } from '@/lib/design-agent/jobs'
import { agentHold, agentTaskState, type AgentTaskState } from '@/lib/design-agent/delivery'
import { AGENT_USER_EMAIL } from '@/lib/design-agent/agent-user'
import { generateAgentRunnerToken, revokeAgentRunnerToken, settleOwnerNotices } from '@/lib/design-agent/runner'
import { AgentJobBusy, workStateFor, workStatesFor } from '@/lib/design-agent/work-state'
import type { BoardEntryInput } from '@/lib/design-agent/work-board'
import { saveLarkConfig } from '@/lib/lark/settings'
import { POST as BUSY } from '@/app/api/design-agent/runner/jobs/[id]/busy/route'
import { agentFixture } from './helpers/design-agent-fixture'
import { LARK_TEST_CONFIG, dropLarkSettings } from './helpers/lark'
import { dropWorkBoard, publishBoard } from './helpers/work-board'

const fx = agentFixture('daw')
let LEAD: Actor
let DES: Actor
let token = ''

const ETA = '2026-11-19T11:00:00.000Z'
const queue = (key: string, state: string, over: Partial<BoardEntryInput> = {}): BoardEntryInput =>
  ({ taskKey: key, source: 'LOCAL_QUEUE', worker: 'Hàng duyệt local', state, ...over })
const stream = (key: string, worker = 'Luồng 7'): BoardEntryInput => ({ taskKey: key, source: 'STREAM', worker, state: 'DOING' })
const stateOf = async (key: string, now?: Date) => workStateFor((await agentTaskState(key)) as AgentTaskState, now)
const taskOf = (key: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
const jobsOf = (key: string) => prisma.designAgentJob.findMany({ where: { taskKey: key }, orderBy: { createdAt: 'asc' } })
const notesOf = async (key: string) =>
  (await prisma.designTaskEvent.findMany({ where: { taskId: (await taskOf(key)).id, type: 'NOTE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map(e => e.message)
const larkJob = (key: string) => enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: key, requestText: 'sửa chữ', requestedBy: 'Lan' })
const openJob = async (key: string, status: 'QUEUED' | 'RUNNING', data: Record<string, unknown> = {}) =>
  prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: (await taskOf(key)).id, taskKey: key, requestText: 'x', status, ...data } })
const busy = (id: string, body: unknown, auth = token) =>
  BUSY(new NextRequest(`http://localhost/api/design-agent/runner/jobs/${id}/busy`, {
    method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: { id } })

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAW' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await dropLarkSettings()
  await dropWorkBoard()
  await fx.cleanup()
  await fx.seed()
  LEAD = (await fx.user('Lead', 'ADMIN')).actor
  DES = (await fx.user('Hoa', 'SUPPORT', ['design_tasks'])).actor
  const orders: Record<number, Parameters<typeof fx.order>[1]> = {
    1: { taskStatus: 'CANCELLED' }, 2: { taskStatus: 'REJECTED' }, 3: { taskStatus: 'REJECTED' }, 4: { taskStatus: 'REJECTED' },
    5: { taskStatus: 'DOING' }, 6: { taskStatus: 'REVIEW' }, 7: { taskStatus: 'REJECTED' }, 8: { taskStatus: 'DOING' },
    9: { taskStatus: 'NEW' }, 10: { taskStatus: 'NEW' }, 11: { taskStatus: 'REJECTED', pipelineStatus: 'FULFILLED' },
    12: { taskStatus: 'ASK_CUSTOMER' }, 13: { taskStatus: 'DONE', exported: true }, 14: { taskStatus: 'ASSIGNED' },
    15: { taskStatus: 'REJECTED' }, 16: { taskStatus: 'REJECTED' }, 17: { taskStatus: 'REJECTED' }, 18: { taskStatus: 'NEW' },
    19: { taskStatus: 'REJECTED', exported: true }, 20: { taskStatus: 'DOING' }, 21: { taskStatus: 'DONE' }, 22: { taskStatus: 'REVIEW' },
  }
  for (const [n, o] of Object.entries(orders)) await fx.order(Number(n), { ...o, withPrint: true })
  await prisma.designTask.update({ where: { taskKey: 'DAW8_1' }, data: { assigneeId: DES.id } })
  await prisma.designTask.update({ where: { taskKey: 'DAW14_1' }, data: { assigneeId: 'user-that-left' } })
  await prisma.designTask.updateMany({ where: { taskKey: { in: ['DAW9_1', 'DAW18_1'] } }, data: { readiness: 'AUTO' } })
  await prisma.designTask.update({ where: { taskKey: 'DAW10_1' }, data: { readiness: 'MANUAL' } })
  token = await generateAgentRunnerToken()
})

afterAll(async () => {
  await settleOwnerNotices()
  await revokeAgentRunnerToken()
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAW' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await dropLarkSettings()
  await dropWorkBoard()
  await fx.cleanup()
})

beforeEach(() => { lark.sendToChat.mockClear(); lark.sendToChat.mockImplementation(async () => {}) })

describe('workStateFor priority order', () => {
  it('CLOSED beats everything', async () => {
    const jobs = [await openJob('DAW1_1', 'QUEUED'), await openJob('DAW11_1', 'QUEUED')]
    await publishBoard(['DAW1_1', 'DAW11_1', 'DAW12_1', 'DAW13_1'].flatMap(k => [queue(k, 'waiting'), stream(k)]), 'Luồng 7')
    expect(await stateOf('DAW1_1')).toEqual({ kind: 'CLOSED', reason: 'CANCELLED' })
    expect(await stateOf('DAW11_1')).toEqual({ kind: 'CLOSED', reason: 'ORDER_CLOSED' })
    expect(await stateOf('DAW12_1')).toEqual({ kind: 'CLOSED', reason: 'ASK_CUSTOMER' })
    expect(await stateOf('DAW13_1')).toEqual({ kind: 'CLOSED', reason: 'SENT' })
    expect(await stateOf('DAW1_1', new Date(Date.now() + 3_600_000))).toEqual({ kind: 'CLOSED', reason: 'CANCELLED' })
    await prisma.designAgentJob.deleteMany({ where: { id: { in: jobs.map(j => j.id) } } })
  })

  it('open agent job', async () => {
    const startedAt = new Date('2026-11-19T09:00:00Z')
    const job = await openJob('DAW2_1', 'RUNNING', { stage: 'vòng 2', startedAt })
    await publishBoard([queue('DAW2_1', 'waiting'), stream('DAW2_1')], 'Luồng 7')
    expect(await stateOf('DAW2_1')).toEqual({ kind: 'AGENT', jobId: job.id, status: 'RUNNING', stage: 'vòng 2', startedAt })
    expect(await stateOf('DAW2_1', new Date(Date.now() + 3_600_000))).toMatchObject({ kind: 'AGENT', jobId: job.id })
    await prisma.designAgentJob.update({ where: { id: job.id }, data: { status: 'DONE' } })
    expect(await stateOf('DAW2_1')).toMatchObject({ kind: 'QUEUE' })
  })

  it('stale board is UNKNOWN', async () => {
    await dropWorkBoard()
    expect(await stateOf('DAW3_1')).toEqual({ kind: 'UNKNOWN' })
    expect(await stateOf('DAW5_1')).toEqual({ kind: 'UNKNOWN' })
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'UNKNOWN' })
    const at = new Date('2026-11-19T10:00:00Z')
    await publishBoard([queue('DAW3_1', 'waiting')], null, at)
    expect(await stateOf('DAW3_1', new Date(at.getTime() + 600_000))).toMatchObject({ kind: 'QUEUE' })
    expect(await stateOf('DAW3_1', new Date(at.getTime() + 600_001))).toEqual({ kind: 'UNKNOWN' })
    expect(await stateOf('DAW10_1', new Date(at.getTime() + 600_001))).toEqual({ kind: 'UNKNOWN' })
  })

  it('stale board still reports PERSON', async () => {
    await dropWorkBoard()
    expect(await stateOf('DAW8_1')).toEqual({ kind: 'PERSON', name: 'Hoa' })
    expect(await stateOf('DAW14_1')).toEqual({ kind: 'PERSON', name: 'nhân sự được giao' })
    const at = new Date('2026-11-19T10:00:00Z')
    await publishBoard([stream('DAW8_1', 'Luồng 3')], null, at)
    expect(await stateOf('DAW8_1', new Date(at.getTime() + 600_001))).toEqual({ kind: 'PERSON', name: 'Hoa' })
    expect(await stateOf('DAW8_1', new Date(at.getTime() + 600_000))).toEqual({ kind: 'STREAM', worker: 'Luồng 3' })
    await dropWorkBoard()
    await expect(enqueueAgentJob({ kind: 'FIX', source: 'BACKFILL', taskKey: 'DAW8_1', requestText: 'x' })).rejects.toMatchObject({ state: { kind: 'PERSON', name: 'Hoa' } })
  })

  it('stale board still reports AUTO', async () => {
    await dropWorkBoard()
    expect(await stateOf('DAW9_1')).toEqual({ kind: 'AUTO' })
    expect(await stateOf('DAW10_1')).toEqual({ kind: 'UNKNOWN' })
    const at = new Date('2026-11-19T10:00:00Z')
    await publishBoard([queue('DAW9_1', 'waiting')], null, at)
    expect(await stateOf('DAW9_1', new Date(at.getTime() + 600_001))).toEqual({ kind: 'AUTO' })
    expect(await stateOf('DAW9_1', new Date(at.getTime() + 600_000))).toMatchObject({ kind: 'QUEUE' })
    await dropWorkBoard()
    await expect(larkJob('DAW9_1')).rejects.toMatchObject({ state: { kind: 'AUTO' } })
    expect(await jobsOf('DAW9_1')).toEqual([])
  })

  it('a leftover queue row on a DONE task is ignored', async () => {
    await publishBoard([queue('DAW21_1', 'waiting', { version: 2, etaAt: ETA })])
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'FREE', heldReason: null })
    await publishBoard([stream('DAW21_1'), queue('DAW21_1', 'held', { detail: 'giữ' })], 'Luồng 7')
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'FREE', heldReason: null })
    await prisma.designTask.update({ where: { taskKey: 'DAW21_1' }, data: { status: 'REJECTED' } })
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 7' })
    await publishBoard([], 'Luồng 7')
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 7' })
    await prisma.designTask.update({ where: { taskKey: 'DAW21_1' }, data: { status: 'DONE' } })
    expect(await stateOf('DAW21_1')).toEqual({ kind: 'FREE', heldReason: null })
  })

  it('a REVIEW task with a waiting row stays QUEUE', async () => {
    await publishBoard([queue('DAW22_1', 'waiting', { version: 4, etaAt: ETA, detail: 'chờ lên cloud' })])
    expect(await stateOf('DAW22_1')).toEqual({ kind: 'QUEUE', state: 'waiting', version: 4, etaAt: new Date(ETA), detail: 'chờ lên cloud' })
    await publishBoard([stream('DAW22_1', 'Luồng 5')])
    expect(await stateOf('DAW22_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 5' })
    await expect(larkJob('DAW22_1')).rejects.toMatchObject({ state: { kind: 'STREAM', worker: 'Luồng 5' } })
  })

  it('waiting queue row', async () => {
    await publishBoard([queue('DAW4_1', 'waiting', { version: 3, etaAt: ETA, detail: 'bản sửa viền' }), stream('DAW4_1')], 'Luồng 7')
    expect(await stateOf('DAW4_1')).toEqual({ kind: 'QUEUE', state: 'waiting', version: 3, etaAt: new Date(ETA), detail: 'bản sửa viền' })
    await publishBoard([queue('DAW4_1', 'held', { detail: 'giữ' }), queue('DAW4_1', 'qa_failed', { detail: 'lệch tâm' })])
    expect(await stateOf('DAW4_1')).toEqual({ kind: 'QUEUE', state: 'qa_failed', version: null, etaAt: null, detail: 'lệch tâm' })
  })

  it('held row is FREE with heldReason', async () => {
    await publishBoard([queue('DAW5_1', 'held', { detail: 'chủ shop giữ: chờ ảnh khách' }), queue('DAW8_1', 'held', { detail: 'giữ' })])
    expect(await stateOf('DAW5_1')).toEqual({ kind: 'FREE', heldReason: 'chủ shop giữ: chờ ảnh khách' })
    expect(await stateOf('DAW8_1')).toEqual({ kind: 'PERSON', name: 'Hoa' })
  })

  it('stream row', async () => {
    await publishBoard([stream('DAW8_1', 'Luồng 3'), queue('DAW8_1', 'held', { detail: 'giữ' })])
    expect(await stateOf('DAW8_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 3' })
  })

  it('REJECTED follows rejectedOwner', async () => {
    await publishBoard([], 'Luồng 7')
    expect(await stateOf('DAW7_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 7' })
    expect(await stateOf('DAW10_1')).toEqual({ kind: 'FREE', heldReason: null })
    await publishBoard([stream('DAW7_1', 'Luồng 2')], 'Luồng 7')
    expect(await stateOf('DAW7_1')).toEqual({ kind: 'STREAM', worker: 'Luồng 2' })
    await publishBoard([])
    expect(await stateOf('DAW7_1')).toEqual({ kind: 'FREE', heldReason: null })
  })

  it('assignee', async () => {
    await publishBoard([])
    expect(await stateOf('DAW8_1')).toEqual({ kind: 'PERSON', name: 'Hoa' })
    expect(await stateOf('DAW14_1')).toEqual({ kind: 'PERSON', name: 'nhân sự được giao' })
    expect(await stateOf('DAW5_1')).toEqual({ kind: 'FREE', heldReason: null })
  })

  it('NEW AUTO', async () => {
    await publishBoard([])
    expect(await stateOf('DAW9_1')).toEqual({ kind: 'AUTO' })
  })

  it('FREE', async () => {
    await publishBoard([queue('DAW4_1', 'waiting')])
    expect(await stateOf('DAW10_1')).toEqual({ kind: 'FREE', heldReason: null })
    expect(await stateOf('DAW3_1')).toEqual({ kind: 'FREE', heldReason: null })
  })

  it('workStatesFor answers many tasks at once, keyed by task key', async () => {
    await publishBoard([queue('DAW4_1', 'waiting'), stream('DAW8_1')])
    const keys = ['DAW1_1', 'DAW4_1', 'DAW8_1', 'DAW9_1', 'DAW10_1']
    const tasks = await Promise.all(keys.map(async k => (await agentTaskState(k)) as AgentTaskState))
    const states = await workStatesFor(tasks)
    expect(keys.map(k => states.get(k)?.kind)).toEqual(['CLOSED', 'QUEUE', 'STREAM', 'AUTO', 'FREE'])
    expect((await workStatesFor([])).size).toBe(0)
  })
})

describe('one worker per line when a job is created', () => {
  it('Lark job refused while queue holds the line', async () => {
    await publishBoard([queue('DAW4_1', 'waiting', { version: 2, etaAt: ETA })])
    const refused = await larkJob('DAW4_1').catch(e => e)
    expect(refused).toBeInstanceOf(AgentJobBusy)
    expect(refused).toBeInstanceOf(AgentJobError)
    expect(refused).toMatchObject({ status: 409, message: 'Hàng duyệt local đang giữ dòng này', state: { kind: 'QUEUE', state: 'waiting', version: 2 } })
    expect(await jobsOf('DAW4_1')).toEqual([])
    expect((await taskOf('DAW4_1')).status).toBe('REJECTED')
    await publishBoard([queue('DAW4_1', 'held', { detail: 'giữ' })])
    expect(await larkJob('DAW4_1')).toMatchObject({ created: true })
  })

  it('a person and a stream block every source, a closed line does not', async () => {
    await publishBoard([stream('DAW15_1')])
    for (const source of ['REJECT', 'LINE_REOPEN', 'LARK', 'AUTO_HOLD', 'BACKFILL'] as const) {
      await expect(enqueueAgentJob({ kind: 'FIX', source, taskKey: 'DAW15_1', requestText: 'x' })).rejects.toMatchObject({ state: { kind: 'STREAM', worker: 'Luồng 7' } })
      await expect(enqueueAgentJob({ kind: 'MOCKUP', source, taskKey: 'DAW8_1', requestText: 'x' })).rejects.toMatchObject({ state: { kind: 'PERSON', name: 'Hoa' } })
    }
    expect(await enqueueAgentJob({ kind: 'LIBRARY_APPLY', source: 'LIBRARY', taskKey: 'DAW15_1', requestText: 'x' })).toMatchObject({ created: true })
    await publishBoard([stream('DAW19_1'), stream('DAW13_1')], 'Luồng 7')
    await prisma.designTask.update({ where: { taskKey: 'DAW19_1' }, data: { status: 'DONE' } })
    expect(await stateOf('DAW19_1')).toEqual({ kind: 'CLOSED', reason: 'SENT' })
    expect(await enqueueAgentJob({ kind: 'FIX', source: 'LINE_REOPEN', taskKey: 'DAW19_1', requestText: 'x', factory: true })).toMatchObject({ created: true })
  })

  it('AUTO_HOLD allowed on an AUTO line', async () => {
    await publishBoard([])
    await saveAgentSettings({ autoFixOnReject: true })
    await expect(larkJob('DAW9_1')).rejects.toMatchObject({ status: 409, message: 'Auto render đang giữ dòng này', state: { kind: 'AUTO' } })
    await expect(enqueueAgentJob({ kind: 'FIX', source: 'BACKFILL', taskKey: 'DAW9_1', requestText: 'x' })).rejects.toBeInstanceOf(AgentJobBusy)
    const held = await agentHold('DAW9_1', 'tên vượt khung')
    expect(held.jobId).toBeTruthy()
    expect(await jobsOf('DAW9_1')).toMatchObject([{ source: 'AUTO_HOLD', status: 'QUEUED' }])
    expect(await notesOf('DAW9_1')).toEqual(['Auto render giữ lại: tên vượt khung'])
  })

  it('a hold on a line a stream keeps leaves one hold note and one refusal, however often it repeats', async () => {
    await publishBoard([stream('DAW18_1', 'Luồng 4')])
    await saveAgentSettings({ autoFixOnReject: true })
    expect(await agentHold('DAW18_1', 'chạm safe zone')).toEqual({ jobId: null })
    expect(await agentHold('DAW18_1', 'chạm safe zone')).toEqual({ jobId: null })
    expect(await notesOf('DAW18_1')).toEqual(['Auto render giữ lại: chạm safe zone', 'Agent không nhận: Luồng 4 đang giữ dòng này'])
    expect(await jobsOf('DAW18_1')).toEqual([])
  })

  it('reject path writes a note and creates no job when a stream holds it', async () => {
    await publishBoard([stream('DAW6_1')])
    await saveAgentSettings({ autoFixOnReject: true })
    await transitionTask('DAW6_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })
    expect((await taskOf('DAW6_1')).status).toBe('REJECTED')
    expect(await jobsOf('DAW6_1')).toEqual([])
    expect(await notesOf('DAW6_1')).toEqual(['Agent không nhận: Luồng 7 đang giữ dòng này'])
    const again = await enqueueFixOnReject({ taskKey: 'DAW6_1', reasons: ['Sai chi tiết'], note: null, by: LEAD, source: 'REJECT', factory: false })
    expect(again).toBeNull()
    expect(await notesOf('DAW6_1')).toEqual(['Agent không nhận: Luồng 7 đang giữ dòng này'])
    await publishBoard([queue('DAW6_1', 'fixing')])
    expect(await enqueueFixOnReject({ taskKey: 'DAW6_1', reasons: ['Sai chi tiết'], note: null, by: LEAD, source: 'LINE_REOPEN', factory: true })).toBeNull()
    expect((await notesOf('DAW6_1')).at(-1)).toBe('Agent không nhận: Hàng duyệt local đang giữ dòng này')
    expect(await jobsOf('DAW6_1')).toEqual([])
  })

  it('backfill skips the lines the rejected owner keeps, with a note', async () => {
    await publishBoard([], 'Luồng 7')
    const r = await backfillRejected({ dryRun: false, by: LEAD, factoryReasons: [] })
    expect(r.taskKeys).toEqual(expect.arrayContaining(['DAW16_1', 'DAW17_1']))
    expect(r.queued).toBe(0)
    expect(await jobsOf('DAW16_1')).toEqual([])
    expect(await notesOf('DAW16_1')).toEqual(['Agent không nhận: Luồng 7 đang giữ dòng này'])
    await publishBoard([stream('DAW16_1', 'Luồng 2')])
    const second = await backfillRejected({ dryRun: false, by: LEAD, factoryReasons: [] })
    expect(second.queued).toBeGreaterThanOrEqual(1)
    expect(await jobsOf('DAW17_1')).toMatchObject([{ source: 'BACKFILL', status: 'QUEUED' }])
    expect(await jobsOf('DAW16_1')).toEqual([])
    expect((await notesOf('DAW16_1')).at(-1)).toBe('Agent không nhận: Luồng 2 đang giữ dòng này')
  })

  it('stale board blocks LARK but not REJECT', async () => {
    await prisma.designAgentJob.deleteMany({ where: { taskKey: 'DAW3_1' } })
    await dropWorkBoard()
    const never = await larkJob('DAW3_1').catch(e => e)
    expect(never).toBeInstanceOf(AgentJobBusy)
    expect(never).toMatchObject({ status: 409, state: { kind: 'UNKNOWN' } })
    await publishBoard([], null, new Date(Date.now() - 600_001 - 5_000))
    await expect(larkJob('DAW3_1')).rejects.toMatchObject({ state: { kind: 'UNKNOWN' } })
    await expect(larkJob('DAW10_1')).rejects.toMatchObject({ state: { kind: 'UNKNOWN' } })
    expect(await jobsOf('DAW3_1')).toEqual([])
    await saveAgentSettings({ autoFixOnReject: true })
    const job = await enqueueFixOnReject({ taskKey: 'DAW3_1', reasons: ['Sai chi tiết'], note: null, by: LEAD, source: 'REJECT', factory: false })
    expect(job).toMatchObject({ source: 'REJECT', status: 'QUEUED' })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAW3_1' } })).toBe(1)
    expect(await enqueueAgentJob({ kind: 'FIX', source: 'BACKFILL', taskKey: 'DAW5_1', requestText: 'x' })).toMatchObject({ created: true })
    await expect(enqueueAgentJob({ kind: 'FIX', source: 'BACKFILL', taskKey: 'DAW8_1', requestText: 'x' })).rejects.toMatchObject({ state: { kind: 'PERSON', name: 'Hoa' } })
  })

  it('busy endpoint cancels the job, notes the task, is idempotent', async () => {
    await saveLarkConfig({ ...LARK_TEST_CONFIG, enabled: true })
    const job = await openJob('DAW20_1', 'RUNNING', { attempts: 1, lockedAt: new Date(), startedAt: new Date() })
    expect((await busy(job.id, { worker: 'x' }, 'dag_wrong')).status).toBe(401)
    expect((await busy(job.id, {})).status).toBe(400)
    expect((await busy(job.id, { worker: '  ' })).status).toBe(400)
    expect((await prisma.designAgentJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('RUNNING')

    const res = await busy(job.id, { worker: 'Hàng duyệt local', detail: 'bản v2 đang chờ duyệt' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'CANCELLED' })
    const row = await prisma.designAgentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(row).toMatchObject({ status: 'CANCELLED', error: 'Đã có bên khác làm: Hàng duyệt local', lockedAt: null })
    expect(row.finishedAt).toBeInstanceOf(Date)
    expect(await notesOf('DAW20_1')).toEqual(['Đã có bên khác làm: Hàng duyệt local — bản v2 đang chờ duyệt'])
    await settleOwnerNotices()
    expect(lark.sendToChat.mock.calls).toEqual([['oc_group', 'DAW20_1: Đã có bên khác làm: Hàng duyệt local — bản v2 đang chờ duyệt']])

    const again = await busy(job.id, { worker: 'Hàng duyệt local' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true, status: 'CANCELLED' })
    await settleOwnerNotices()
    expect(await notesOf('DAW20_1')).toHaveLength(1)
    expect(lark.sendToChat).toHaveBeenCalledTimes(1)

    const queued = await openJob('DAW20_1', 'QUEUED')
    expect((await busy(queued.id, { worker: 'Luồng 7' })).status).toBe(409)
    expect((await busy('no-such-job', { worker: 'Luồng 7' })).status).toBe(409)
    expect((await prisma.designAgentJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('QUEUED')
  })

  it('busy endpoint: a failing Lark or Lark switched off never fails the request', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await prisma.designAgentJob.deleteMany({ where: { taskKey: 'DAW20_1' } })
    lark.sendToChat.mockRejectedValueOnce(new Error('lark down'))
    const failing = await openJob('DAW20_1', 'RUNNING', { attempts: 1, lockedAt: new Date() })
    const res = await busy(failing.id, { worker: 'Luồng 7' })
    expect(res.status).toBe(200)
    await settleOwnerNotices()
    expect(lark.sendToChat).toHaveBeenCalledTimes(1)
    expect((await prisma.designAgentJob.findUniqueOrThrow({ where: { id: failing.id } })).error).toBe('Đã có bên khác làm: Luồng 7')
    expect((await notesOf('DAW20_1')).at(-1)).toBe('Đã có bên khác làm: Luồng 7')

    await saveLarkConfig({ enabled: false })
    lark.sendToChat.mockClear()
    const quiet = await openJob('DAW20_1', 'RUNNING', { attempts: 1, lockedAt: new Date() })
    expect((await busy(quiet.id, { worker: 'Luồng 7' })).status).toBe(200)
    await settleOwnerNotices()
    expect(lark.sendToChat).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
