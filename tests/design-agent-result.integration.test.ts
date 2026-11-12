import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn<(notice: unknown) => Promise<void>>(async () => {}))
vi.mock('@/lib/design-agent/notify', () => ({ notifyNeedsOwner: notify }))

import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { transitionTask, type Actor } from '@/lib/design-tasks'
import { openJobForTask } from '@/lib/design-agent/jobs'
import { AGENT_USER_EMAIL } from '@/lib/design-agent/agent-user'
import { agentSubmit } from '@/lib/design-agent/delivery'
import { completeAgentJob, failAgentJob, settleOwnerNotices } from '@/lib/design-agent/runner'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('das')
let LEAD: Actor
const ids: Record<string, string> = {}

const rowOf = (id: string) => prisma.designAgentJob.findUniqueOrThrow({ where: { id } })
const taskId = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).id

async function lastEvent(key: string) {
  const e = await prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: await taskId(key) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const actor = e.actorId ? await prisma.appUser.findUnique({ where: { id: e.actorId } }) : null
  return { type: e.type, message: e.message, actorName: actor?.name ?? null }
}

async function running(key: string, data: Record<string, unknown> = {}) {
  return (await prisma.designAgentJob.create({
    data: {
      kind: 'FIX', source: 'REJECT', taskId: await taskId(key), taskKey: key, requestText: 'Lý do: Sai chi tiết',
      status: 'RUNNING', attempts: 1, lockedAt: new Date(), startedAt: new Date(Date.now() - 60_000), ...data,
    },
  })).id
}

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAS' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
  await fx.seed()
  LEAD = (await fx.user('Lead', 'ADMIN')).actor
  await fx.order(1, { taskStatus: 'REJECTED', withPrint: true })
  await fx.order(2, { taskStatus: 'NEW' })
  for (const n of [3, 4, 5, 6, 7, 8, 9]) await fx.order(n, { skus: [`DS${n}-Hoodie`], taskStatus: 'REJECTED', withPrint: true })
  ids.j1 = await running('DAS1_1')
  ids.j3 = await running('DAS3_1')
  ids.j4 = await running('DAS4_1')
  ids.j5 = await running('DAS5_1')
  ids.jLone = await running('DAS6_1')
  ids.queued = (await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId('DAS7_1'), taskKey: 'DAS7_1', requestText: 'x' } })).id
  ids.running = await running('DAS8_1')
  ids.failing = await running('DAS9_1')
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAS' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await fx.cleanup()
})

describe('result of an agent job', () => {
  it('DONE after a real submit: note on the task and the library question', async () => {
    expect(await agentSubmit('DAS1_1')).toEqual({ moved: true })
    expect(await completeAgentJob(ids.j1, { outcome: 'DONE', summary: 'Đã sửa thân trước', rounds: 2, result: { pushed: ['FRONT'] } })).toEqual({ status: 'DONE' })
    const row = await rowOf(ids.j1)
    expect(row).toMatchObject({ status: 'DONE', rounds: 2, libraryState: 'ASKED', lockedAt: null, summary: 'Đã sửa thân trước' })
    expect(row.finishedAt).not.toBeNull()
    expect(JSON.parse(row.resultJson!)).toEqual({ pushed: ['FRONT'] })
    expect(JSON.parse(row.affectedJson!).rows.map((r: any) => r.taskKey)).toEqual(['DAS2_1'])
    expect(JSON.parse(row.affectedJson!).fulfilledCount).toBe(0)
    expect(await lastEvent('DAS1_1')).toMatchObject({ type: 'NOTE', message: 'Agent: Đã sửa thân trước', actorName: 'Design Agent' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('DONE with no other order of the design asks nothing', async () => {
    await agentSubmit('DAS6_1')
    expect(await completeAgentJob(ids.jLone, { outcome: 'DONE', summary: 'xong' })).toEqual({ status: 'DONE' })
    expect((await rowOf(ids.jLone)).libraryState).toBeNull()
  })

  it('DONE without a submit becomes NEEDS_OWNER', async () => {
    expect(await completeAgentJob(ids.j3, { outcome: 'DONE', summary: 'xong' })).toEqual({ status: 'NEEDS_OWNER' })
    expect(await rowOf(ids.j3)).toMatchObject({ status: 'NEEDS_OWNER', summary: 'xong\n(Agent báo xong nhưng task chưa được gửi duyệt.)', libraryState: null })
    await settleOwnerNotices()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ jobId: ids.j3, taskKey: 'DAS3_1', kind: 'FIX', reason: 'NEEDS_OWNER' }))
  })

  it('a delivery rejected again before the result arrives is not lost', async () => {
    await saveAgentSettings({ autoFixOnReject: true })
    await agentSubmit('DAS4_1')
    await transitionTask('DAS4_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAS4_1' } })).toBe(1)
    expect(await completeAgentJob(ids.j4, { outcome: 'DONE', summary: 'xong' })).toEqual({ status: 'DONE' })
    expect((await rowOf(ids.j4)).libraryState).toBeNull()
    expect(await openJobForTask(await taskId('DAS4_1'))).toMatchObject({ status: 'QUEUED', source: 'REJECT', requestText: 'Lý do: Sai chi tiết', requestedBy: 'Design Agent' })
  })

  it('NEEDS_OWNER calls the owner once and a failing notice never fails the result', async () => {
    notify.mockClear()
    notify.mockRejectedValueOnce(new Error('lark down'))
    expect(await completeAgentJob(ids.j5, { outcome: 'NEEDS_OWNER', summary: '3 vòng chưa đạt' })).toEqual({ status: 'NEEDS_OWNER' })
    await settleOwnerNotices()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ jobId: ids.j5, taskKey: 'DAS5_1', kind: 'FIX', reason: 'NEEDS_OWNER', summary: '3 vòng chưa đạt' })
    expect(await rowOf(ids.j5)).toMatchObject({ status: 'NEEDS_OWNER', summary: '3 vòng chưa đạt' })
  })

  it('refusals', async () => {
    expect(await completeAgentJob(ids.queued, { outcome: 'DONE', summary: 'x' })).toMatchObject({ status: 409, error: 'not running' })
    expect(await completeAgentJob(ids.j1, { outcome: 'DONE', summary: 'x' })).toMatchObject({ status: 409, error: 'not running' })
    expect(await completeAgentJob(ids.running, { outcome: 'OK', summary: 'x' })).toMatchObject({ status: 400, error: 'outcome và summary là bắt buộc' })
    expect(await completeAgentJob(ids.running, { outcome: 'DONE', summary: ' ' })).toMatchObject({ status: 400 })
    expect(await completeAgentJob(ids.running, { outcome: 'DONE' } as any)).toMatchObject({ status: 400 })
  })

  it('a job that ends FAILED calls the owner', async () => {
    notify.mockClear()
    expect(await failAgentJob(ids.failing, { error: 'no result.json', permanent: true })).toEqual({ status: 'FAILED', attempts: 1 })
    await settleOwnerNotices()
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ jobId: ids.failing, reason: 'FAILED', summary: 'no result.json' }))
  })

  it('a Lark notice that never answers does not hold up the result or the failure', async () => {
    const held: (() => void)[] = []
    const hang = () => new Promise<void>(r => { held.push(r) })
    const soon = <T>(p: Promise<T>) => Promise.race([p, new Promise<'late'>(r => setTimeout(() => r('late'), 2000))])
    notify.mockClear()
    notify.mockImplementation(hang)
    const owner = await running('DAS5_1')
    expect(await soon(completeAgentJob(owner, { outcome: 'NEEDS_OWNER', summary: 'Lark treo' }))).toEqual({ status: 'NEEDS_OWNER' })
    expect(await rowOf(owner)).toMatchObject({ status: 'NEEDS_OWNER', summary: 'Lark treo' })
    const failed = await running('DAS9_1')
    expect(await soon(failAgentJob(failed, { error: 'boom', permanent: true }))).toEqual({ status: 'FAILED', attempts: 1 })
    expect(await rowOf(failed)).toMatchObject({ status: 'FAILED', error: 'boom' })
    expect(notify).toHaveBeenCalledTimes(2)
    notify.mockImplementation(async () => {})
    held.forEach(release => release())
    await settleOwnerNotices()
  })

  it('a rejecting notice is swallowed and logged, for the result and the failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    notify.mockClear()
    notify.mockRejectedValueOnce(new Error('lark down')).mockRejectedValueOnce(new Error('lark down'))
    const owner = await running('DAS5_1')
    expect(await completeAgentJob(owner, { outcome: 'NEEDS_OWNER', summary: 'x' })).toEqual({ status: 'NEEDS_OWNER' })
    const failed = await running('DAS9_1')
    expect(await failAgentJob(failed, { error: 'y', permanent: true })).toEqual({ status: 'FAILED', attempts: 1 })
    await settleOwnerNotices()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.filter(c => String(c[0]).includes('không báo được chủ shop'))).toHaveLength(2)
    log.mockRestore()
  })
})
