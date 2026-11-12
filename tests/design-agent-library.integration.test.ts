import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { listTasks, loadTask, transitionTask, type Actor } from '@/lib/design-tasks'
import { AGENT_USER_EMAIL } from '@/lib/design-agent/agent-user'
import { decideLibrary } from '@/lib/design-agent/jobs'
import { claimAgentJobs, completeAgentJob } from '@/lib/design-agent/runner'
import { runningJobCovering } from '@/lib/design-agent/delivery'
import { POST as libraryRoute } from '@/app/api/design-agent/jobs/[id]/library/route'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dal')
let LEAD: Actor
let des = ''
let sellerOfOtherStore = ''
const ids: Record<string, string> = {}

const rowOf = (id: string) => prisma.designAgentJob.findUniqueOrThrow({ where: { id } })
const taskId = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).id

async function lastNote(key: string) {
  return (await prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: await taskId(key), type: 'NOTE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).message
}

const row = (n: number, key: string) => ({ taskKey: key, orderNumber: `#DAL${n}`, placedAt: '2026-11-01T00:00:00.000Z', taskStatus: 'DONE', sent: false, sameSupplierSku: false })

async function asked(key: string, extra: Record<string, unknown> = {}, rows = 2) {
  return (await prisma.designAgentJob.create({
    data: {
      kind: 'FIX', source: 'REJECT', taskId: await taskId(key), taskKey: key, requestText: 'x', status: 'DONE', attempts: 1, summary: 'Đã sửa thân trước', designCode: `D${key.slice(2, 4)}`,
      libraryState: 'ASKED', affectedJson: JSON.stringify({ rows: Array.from({ length: rows }, (_, i) => row(i, `OTHER${i}_1`)), fulfilledCount: 0 }), ...extra,
    },
  })).id
}

function post(jobId: string, body: unknown, cookie: string) {
  return libraryRoute(new NextRequest(`http://localhost/api/design-agent/jobs/${jobId}/library`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  }), { params: { id: jobId } })
}

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAL' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
  await fx.seed()
  LEAD = (await fx.user('Lead', 'ADMIN')).actor
  des = (await fx.user('Des', 'SUPPORT', ['design_tasks'])).cookie
  const seller = await fx.user('Seller', 'SELLER', ['design_tasks'])
  sellerOfOtherStore = seller.cookie
  await prisma.userStoreAccess.create({ data: { userId: seller.actor.id, storeId: fx.otherStoreId } })
  await fx.order(1, { skus: ['DL1-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
  await fx.order(2, { skus: ['DL2-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
  await fx.order(3, { skus: ['DL2-Hoodie'], taskStatus: 'DONE' })
  await fx.order(4, { skus: ['DL2-Hoodie'], taskStatus: 'DONE' })
  await fx.order(5, { skus: ['DL5-Hoodie'], taskStatus: 'DONE', withPrint: true })
  await fx.order(6, { skus: ['DL6-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
  await fx.order(10, { skus: ['DL10-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(11, { skus: ['DL11-Hoodie'], taskStatus: 'REJECTED' })
  await fx.order(12, { skus: ['DL12-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
  ids.jNo = await asked('DAL1_1')
  ids.jYes = await asked('DAL2_1')
  ids.jLate = await asked('DAL5_1')
  ids.jAsk = await asked('DAL6_1')
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAL' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await fx.cleanup()
})

describe('library decision', () => {
  it('"Chỉ sửa đơn này" closes the question for good', async () => {
    expect(await decideLibrary(ids.jNo, false, LEAD)).toEqual({ libraryState: 'NO', applyJobId: null })
    await transitionTask('DAL1_1', LEAD, { to: 'DONE' })
    expect(await prisma.designAgentJob.count({ where: { kind: 'LIBRARY_APPLY', taskKey: 'DAL1_1' } })).toBe(0)
    expect(await lastNote('DAL1_1')).toBe('Lưu thư viện: không — chỉ sửa đơn này')
  })

  it('"Lưu thư viện" waits for the approval, then queues one LIBRARY_APPLY job', async () => {
    expect(await decideLibrary(ids.jYes, true, LEAD)).toEqual({ libraryState: 'YES', applyJobId: null })
    expect(await lastNote('DAL2_1')).toBe('Lưu thư viện: có — cập nhật 2 đơn sau khi duyệt')
    await transitionTask('DAL2_1', LEAD, { to: 'DONE' })
    const apply = await prisma.designAgentJob.findMany({ where: { parentJobId: ids.jYes } })
    expect(apply).toMatchObject([{ kind: 'LIBRARY_APPLY', source: 'LIBRARY', status: 'QUEUED', taskKey: 'DAL2_1', requestedBy: 'Lead', requestText: expect.stringContaining('DL2') }])
    ids.apply = apply[0].id
    await transitionTask('DAL2_1', LEAD, { to: 'DOING' })
    await transitionTask('DAL2_1', LEAD, { to: 'REVIEW' })
    await transitionTask('DAL2_1', LEAD, { to: 'DONE' })
    expect(await prisma.designAgentJob.count({ where: { parentJobId: ids.jYes } })).toBe(1)
  })

  it('a yes given after the approval queues at once; a second answer is refused', async () => {
    expect((await decideLibrary(ids.jLate, true, LEAD)).applyJobId).toEqual(expect.any(String))
    await expect(decideLibrary(ids.jLate, false, LEAD)).rejects.toMatchObject({ status: 409, message: 'Câu hỏi này đã được trả lời' })
    await expect(decideLibrary('nope', true, LEAD)).rejects.toMatchObject({ status: 404 })
  })

  it('the apply claim lists the orders as they are now and names its parent', async () => {
    await fx.order(9, { skus: ['DL2-Hoodie'], taskStatus: 'DONE' })
    await prisma.order.update({ where: { id: 'gid://test/Order/dal-3' }, data: { pipelineStatus: 'FULFILLED' } })
    const claims = await claimAgentJobs(5)
    const claim = claims.find(c => c.task.key === 'DAL2_1')!
    expect(claim).toMatchObject({ kind: 'LIBRARY_APPLY', parent: { id: ids.jYes, summary: 'Đã sửa thân trước' }, task: { key: 'DAL2_1', status: 'DONE' } })
    expect(claim.affected.map(a => a.taskKey)).toEqual(['DAL4_1', 'DAL9_1'])
    expect(JSON.parse((await rowOf(claim.id)).affectedJson!).rows.map((r: any) => r.taskKey)).toEqual(['DAL4_1', 'DAL9_1'])
    expect(await runningJobCovering('DAL9_1')).toMatchObject({ id: claim.id })
    ids.applyClaim = claim.id
  })

  it('a finished apply marks the fix as APPLIED', async () => {
    await completeAgentJob(ids.applyClaim, { outcome: 'DONE', summary: 'Đã cập nhật 2 đơn' })
    expect((await rowOf(ids.jYes)).libraryState).toBe('APPLIED')
  })

  it('an older yes is not applied once a later job of the task was answered no or did not finish', async () => {
    await fx.order(13, { skus: ['DL13-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
    await fx.order(14, { skus: ['DL14-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
    const older = new Date('2026-11-10T00:00:00Z')
    const later = new Date('2026-11-11T00:00:00Z')
    const yes13 = await asked('DAL13_1', { libraryState: 'YES', createdAt: older })
    await asked('DAL13_1', { libraryState: 'NO', createdAt: later })
    const yes14 = await asked('DAL14_1', { libraryState: 'YES', createdAt: older })
    await asked('DAL14_1', { status: 'FAILED', libraryState: null, affectedJson: null, createdAt: later })
    await transitionTask('DAL13_1', LEAD, { to: 'DONE' })
    await transitionTask('DAL14_1', LEAD, { to: 'DONE' })
    expect(await prisma.designAgentJob.count({ where: { parentJobId: { in: [yes13, yes14] } } })).toBe(0)
    expect(await prisma.designAgentJob.count({ where: { kind: 'LIBRARY_APPLY', taskKey: { in: ['DAL13_1', 'DAL14_1'] } } })).toBe(0)
  })

  it('route: design permission and the task\'s store', async () => {
    expect((await post(ids.jAsk, { save: 'yes' }, des)).status).toBe(400)
    expect((await post(ids.jAsk, { save: true }, sellerOfOtherStore)).status).toBe(404)
    expect((await post('nope', { save: true }, des)).status).toBe(404)
    expect(await (await post(ids.jAsk, { save: true }, des)).json()).toEqual({ libraryState: 'YES', applyJobId: null })
    expect((await post(ids.jAsk, { save: false }, des)).status).toBe(409)
  })
})

describe('task view', () => {
  it('the task page and the list carry the agent state', async () => {
    await asked('DAL12_1', { affectedJson: JSON.stringify({ rows: [row(0, 'DAL6_1')], fulfilledCount: 2 }) })
    await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId('DAL10_1'), taskKey: 'DAL10_1', requestText: 'x', status: 'CANCELLED' } })
    await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: await taskId('DAL11_1'), taskKey: 'DAL11_1', requestText: 'x', status: 'QUEUED' } })
    expect((await loadTask('DAL12_1'))!.agent).toMatchObject({ status: 'DONE', libraryState: 'ASKED', affected: [{ taskKey: 'DAL6_1' }], fulfilledCount: 2, apply: null })
    expect((await loadTask('DAL10_1'))!.agent).toBeNull()
    expect((await listTasks({ taskKeys: ['DAL11_1', 'DAL10_1'] })).map(t => t.agent).sort()).toEqual(['QUEUED', null])
  })
})
