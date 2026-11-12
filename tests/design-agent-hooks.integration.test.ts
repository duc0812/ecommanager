import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { reopenLineForFix, submitAutoRenderForReview, transitionTask, type Actor } from '@/lib/design-tasks'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dah')
let LEAD: Actor
let DES: Actor
let AGENT: Actor
let desId = ''
let sentLineId = ''
let otherSentLineId = ''

const jobsOf = (taskKey: string) => prisma.designAgentJob.findMany({ where: { taskKey }, orderBy: { createdAt: 'asc' } })
const reject = (key: string) => transitionTask(key, LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })
const lineOf = async (orderId: string) => (await prisma.orderLine.findFirstOrThrow({ where: { orderId, shopifyLineId: 'l1' } })).id

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAH' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
  await fx.seed()
  LEAD = (await fx.user('Lead', 'ADMIN')).actor
  DES = (await fx.user('Des', 'SUPPORT', ['design_tasks'])).actor
  AGENT = { ...(await fx.user('Design Agent', 'SUPPORT', ['design_tasks'])).actor, name: 'Design Agent' }
  desId = DES.id
  await fx.order(1, { taskStatus: 'REVIEW', withPrint: true })
  await fx.order(2, { taskStatus: 'REVIEW', withPrint: true })
  sentLineId = await lineOf((await fx.order(3, { taskStatus: 'DONE', withPrint: true, exported: true })).orderId)
  await fx.order(4, { taskStatus: 'REVIEW', withPrint: true })
  await fx.order(5, { taskStatus: 'DONE', withPrint: true })
  await prisma.designTask.update({ where: { taskKey: 'DAH5_1' }, data: { assigneeId: desId } })
  await fx.order(6, { taskStatus: 'DONE', withPrint: true })
  otherSentLineId = await lineOf((await fx.order(7, { taskStatus: 'DONE', withPrint: true, exported: true })).orderId)
  await fx.order(8, { taskStatus: 'REJECTED', withPrint: true })
  await fx.order(9, { taskStatus: 'REJECTED', withPrint: true })
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAH' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
})

describe('design agent hooks in design-tasks', () => {
  it('switch off: a reject queues nothing', async () => {
    await reject('DAH1_1')
    expect(await jobsOf('DAH1_1')).toEqual([])
  })

  it('switch on: a reject queues one FIX job with the reasons and the note', async () => {
    await saveAgentSettings({ autoFixOnReject: true })
    await transitionTask('DAH2_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết', 'Khác: sao trên mũ lệch'], note: 'xem mockup' })
    expect(await jobsOf('DAH2_1')).toMatchObject([{
      kind: 'FIX', source: 'REJECT', status: 'QUEUED', priority: 0, requestedBy: 'Lead',
      requestText: 'Lý do: Sai chi tiết; Khác: sao trên mũ lệch\nGhi chú: xem mockup',
    }])
  })

  it('a reopened sent line queues with priority 10, and so does a later reject of it', async () => {
    await reopenLineForFix(sentLineId, LEAD, { reason: 'Xưởng yêu cầu update design', note: 'lệch tâm' })
    expect(await jobsOf('DAH3_1')).toMatchObject([{ source: 'LINE_REOPEN', priority: 10, requestText: 'Lý do: Xưởng yêu cầu update design\nGhi chú: lệch tâm' }])
    await prisma.designAgentJob.deleteMany({ where: { taskKey: 'DAH3_1' } })
    await prisma.designTask.update({ where: { taskKey: 'DAH3_1' }, data: { status: 'REVIEW' } })
    await transitionTask('DAH3_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })
    expect(await jobsOf('DAH3_1')).toMatchObject([{ source: 'REJECT', priority: 10, requestText: 'Lý do: Xưởng yêu cầu update design; Sai chi tiết' }])
  })

  it('a person resubmitting a rejected task cancels its queued job', async () => {
    await transitionTask('DAH2_1', DES, { to: 'REVIEW' })
    expect((await jobsOf('DAH2_1'))[0]).toMatchObject({ status: 'CANCELLED', error: 'Task đã được người xử lý trước khi Agent nhận' })
  })

  it('the agent option only reopens, keeps the assignee, queues nothing', async () => {
    await expect(transitionTask('DAH4_1', AGENT, { to: 'DONE' }, { agent: true })).rejects.toThrow('Agent chỉ được mở lại task đã duyệt')
    await expect(transitionTask('DAH4_1', AGENT, { to: 'REJECTED', reasons: ['x'] }, { agent: true })).rejects.toThrow('Agent chỉ được mở lại task đã duyệt')
    const r = await transitionTask('DAH5_1', AGENT, { to: 'DOING' }, { agent: true })
    expect(r.task).toMatchObject({ status: 'DOING', assigneeId: desId })
    expect((await transitionTask('DAH6_1', AGENT, { to: 'DOING' }, { agent: true })).task.assigneeId).toBeNull()
    await reopenLineForFix(otherSentLineId, AGENT, { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }, { agent: true })
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAH7_1' } })).status).toBe('REJECTED')
    expect(await jobsOf('DAH7_1')).toEqual([])
  })

  it('an auto render moving a rejected task to review cancels its queued job', async () => {
    const o8 = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAH8_1' } })
    await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', taskId: o8.id, taskKey: 'DAH8_1', requestText: 'Lý do: Sai chi tiết' } })
    expect(await submitAutoRenderForReview(o8.orderId, o8.shopifyLineId)).toEqual({ moved: true, reason: null })
    expect((await jobsOf('DAH8_1'))[0]).toMatchObject({ status: 'CANCELLED', error: 'Task đã được người xử lý trước khi Agent nhận' })
  })

  it('an auto render with no job and the switch off changes nothing else', async () => {
    await saveAgentSettings({ autoFixOnReject: false })
    const o9 = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAH9_1' } })
    expect(await submitAutoRenderForReview(o9.orderId, o9.shopifyLineId)).toEqual({ moved: true, reason: null })
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAH9_1' } })).status).toBe('REVIEW')
    expect(await jobsOf('DAH9_1')).toEqual([])
  })
})
