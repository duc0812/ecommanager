import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import {
  buildRequestText, enqueueAgentJob, enqueueFixOnReject, cancelQueuedJobsForTask, openJobForTask, openJobStatusByTask, waitForAgentQueue,
} from '@/lib/design-agent/jobs'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('daj')
let taskIds: string[] = []

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
  for (const n of [1, 2, 3, 4]) await fx.order(n)
  taskIds = (await prisma.designTask.findMany({ where: { taskKey: { startsWith: 'DAJ' } }, orderBy: { taskKey: 'asc' } })).map(t => t.id)
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAJ' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
})

describe('design agent job store', () => {
  it('buildRequestText', () => {
    expect(buildRequestText(['Sai chi tiết', 'Khác: sao trên mũ lệch'], 'xem mockup')).toBe('Lý do: Sai chi tiết; Khác: sao trên mũ lệch\nGhi chú: xem mockup')
    expect(buildRequestText(['Sai chi tiết'])).toBe('Lý do: Sai chi tiết')
  })

  it('one open job per task; a Lark request is appended to a queued one', async () => {
    const a = await enqueueAgentJob({ kind: 'FIX', source: 'REJECT', taskKey: 'DAJ1_1', requestText: 'Lý do: Sai chi tiết', requestedBy: 'Huong', factory: true })
    expect(a).toMatchObject({ created: true, appended: false })
    expect(a.job).toMatchObject({ status: 'QUEUED', priority: 10, designCode: 'DN1', taskKey: 'DAJ1_1' })
    const b = await enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAJ1_1', requestText: 'sao lệch', requestedBy: 'Lan' })
    expect(b).toMatchObject({ created: false, appended: true })
    expect(b.job.requestText).toBe('Lý do: Sai chi tiết\nLan: sao lệch')
    await prisma.designAgentJob.update({ where: { id: a.job.id }, data: { status: 'RUNNING' } })
    expect(await enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAJ1_1', requestText: 'x', requestedBy: 'Lan' })).toMatchObject({ created: false, appended: false })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAJ1_1' } })).toBe(1)
  })

  it('unknown task is a 404', async () => {
    await expect(enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'NOPE_1', requestText: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('LIBRARY_APPLY neither blocks nor is blocked by another job of the task', async () => {
    const lib = await enqueueAgentJob({ kind: 'LIBRARY_APPLY', source: 'LIBRARY', taskKey: 'DAJ1_1', requestText: 'x' })
    expect(lib.created).toBe(true)
    expect((await openJobForTask(taskIds[0]))?.kind).toBe('FIX')
    expect((await openJobStatusByTask(taskIds)).get(taskIds[0])).toBe('RUNNING')
  })

  it('enqueueFixOnReject follows the switch', async () => {
    const input = { taskKey: 'DAJ2_1', reasons: ['Sai chi tiết'], note: null, by: { id: 'u1', name: 'Lead' }, source: 'REJECT' as const, factory: false }
    expect(await enqueueFixOnReject(input)).toBeNull()
    await saveAgentSettings({ autoFixOnReject: true })
    expect(await enqueueFixOnReject(input)).toMatchObject({ kind: 'FIX', source: 'REJECT', requestedBy: 'Lead', priority: 0 })
    expect(await enqueueFixOnReject({ ...input, taskKey: 'NOPE_1' })).toBeNull()
  })

  it('cancelQueuedJobsForTask leaves a running job alone', async () => {
    expect(await cancelQueuedJobsForTask(taskIds[0], 'đã duyệt')).toBe(0)
    expect(await cancelQueuedJobsForTask(taskIds[1], 'task đổi trạng thái')).toBe(1)
    const j = await prisma.designAgentJob.findFirstOrThrow({ where: { taskKey: 'DAJ2_1' } })
    expect(j).toMatchObject({ status: 'CANCELLED', error: 'task đổi trạng thái' })
    expect(j.finishedAt).not.toBeNull()
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAJ1_1', status: 'RUNNING' } })).toBe(1)
  })

  it('a waiter wakes on enqueue and none is left behind', async () => {
    const woke = waitForAgentQueue(5000)
    await enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAJ3_1', requestText: 'x', requestedBy: 'Lan' })
    await woke
    expect(globalThis.__designAgentQueueWaiters?.size ?? 0).toBe(0)
  })
})
