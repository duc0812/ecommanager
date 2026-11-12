import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { saveAgentSettings } from '@/lib/design-settings'
import { loadTask } from '@/lib/design-tasks'
import { AGENT_USER_EMAIL } from '@/lib/design-agent/agent-user'
import {
  agentAddNote, agentHold, agentRejectReview, agentReopenTask, agentSubmit, agentTaskState, agentUploadGuard, runningJobCovering,
} from '@/lib/design-agent/delivery'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('dad')
const TPL_SKU = 'DAD-FB'
let o4: Awaited<ReturnType<typeof fx.order>>

const rowOf = (id: string) => prisma.designAgentJob.findUniqueOrThrow({ where: { id } })
const taskId = async (key: string) => (await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })).id

async function lastEvent(key: string) {
  const e = await prisma.designTaskEvent.findFirstOrThrow({ where: { taskId: await taskId(key) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const actor = e.actorId ? await prisma.appUser.findUnique({ where: { id: e.actorId } }) : null
  return { type: e.type, message: e.message, actorName: actor?.name ?? null }
}

async function run(key: string, kind = 'FIX', extra: Record<string, unknown> = {}) {
  return prisma.designAgentJob.create({
    data: { kind, source: 'REJECT', taskId: await taskId(key), taskKey: key, requestText: 'x', status: 'RUNNING', attempts: 1, lockedAt: new Date(), startedAt: new Date(), ...extra },
  })
}

beforeAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAD' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await fx.cleanup()
  await fx.seed()
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await prisma.printTemplate.create({ data: {
    supplierId: fx.supplierId, supplierSku: TPL_SKU, name: 'DAD Front Back', widthPx: 2000, heightPx: 1000,
    areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1000, h: 1000 }, { name: 'Back', x: 1000, y: 0, w: 1000, h: 1000 }]),
  } })
  await fx.order(1, { skus: ['DD1-Hoodie'], taskStatus: 'REJECTED', withPrint: true })
  await fx.order(2, { skus: ['DD2-Hoodie'], taskStatus: 'DONE', withPrint: true })
  const o3 = await fx.order(3, { skus: ['DD3-Hoodie'], taskStatus: 'REJECTED', supplierSku: TPL_SKU })
  await prisma.designArtwork.create({ data: { orderId: o3.orderId, shopifyLineId: 'l1', printArea: 'Front', version: 1, fileName: 'Front.png', storagePath: 'x/dad-3.png', size: 1, mimeType: 'image/png' } })
  o4 = await fx.order(4, { skus: ['DD4-Hoodie'], taskStatus: 'DONE', withPrint: true })
  await prisma.order.update({ where: { id: o4.orderId }, data: { designReady: true } })
  await fx.order(5, { skus: ['DD5-Hoodie'], taskStatus: 'DONE', withPrint: true, exported: true })
  await fx.order(6, { skus: ['DD6-Hoodie'], taskStatus: 'DONE', withPrint: true, exported: true })
  const o7 = await fx.order(7, { skus: ['DD7-Hoodie'], withPrint: true, exported: true })
  await prisma.designTask.deleteMany({ where: { orderId: o7.orderId } })
  await fx.order(8, { skus: ['DD8-Hoodie'], taskStatus: 'REVIEW', withPrint: true })
  await fx.order(9, { skus: ['DD9-Hoodie'] })
  await fx.order(10, { skus: ['DD10-Hoodie'] })
  await fx.order(11, { skus: ['DD11-Hoodie'] })
  await fx.order(12, { skus: ['DD12-Hoodie'], taskStatus: 'DONE', withPrint: true, pipelineStatus: 'FULFILLED' })
  await fx.order(13, { skus: ['DD13-Hoodie'], taskStatus: 'DONE', withPrint: true, exported: true, pipelineStatus: 'CANCELLED' })
  const o14 = await fx.order(14, { skus: ['DD14-Hoodie'], withPrint: true, exported: true })
  await prisma.designTask.deleteMany({ where: { orderId: o14.orderId } })
  await prisma.order.update({ where: { id: o14.orderId }, data: { financialStatus: 'REFUNDED' } })
  await run('DAD2_1', 'MOCKUP')
  await run('DAD4_1', 'LIBRARY_APPLY', { source: 'LIBRARY', affectedJson: JSON.stringify({ rows: [{ taskKey: 'DAD9_1' }], fulfilledCount: 0 }) })
})

afterAll(async () => {
  await prisma.designAgentJob.deleteMany({ where: { taskKey: { startsWith: 'DAD' } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: fx.supplierId } })
  await prisma.appUser.deleteMany({ where: { email: AGENT_USER_EMAIL } })
  await fx.cleanup()
})

describe('delivery as the Design Agent', () => {
  it('upload guard', async () => {
    expect(await agentUploadGuard('DAD1_1', 'PRINT')).toMatchObject({ status: 409, error: 'Task không có job Agent đang chạy' })
    await run('DAD1_1')
    expect(await agentUploadGuard('DAD1_1', 'PRINT')).toEqual({ ok: true })
    expect(await agentUploadGuard('DAD9_1', 'PRINT')).toEqual({ ok: true })
    expect((await runningJobCovering('DAD9_1'))?.kind).toBe('LIBRARY_APPLY')
    expect(await agentUploadGuard('DAD2_1', 'PRINT')).toMatchObject({ status: 409, error: 'Task đã duyệt — mở lại trước khi thay file in' })
    expect(await agentUploadGuard('DAD2_1', 'MOCKUP')).toEqual({ ok: true })
    expect(await agentUploadGuard('DAD10_1', 'MOCKUP')).toMatchObject({ status: 409 })
  })

  it('submit moves a rejected task to review as Design Agent, and refuses an incomplete set', async () => {
    expect(await agentSubmit('DAD1_1')).toEqual({ moved: true })
    expect(await lastEvent('DAD1_1')).toMatchObject({ type: 'STATUS', message: 'Gửi duyệt lại (Agent)', actorName: 'Design Agent' })
    expect((await loadTask('DAD1_1'))!.task.status).toBe('REVIEW')
    expect(await agentSubmit('DAD1_1')).toEqual({ moved: true })
    expect(await agentSubmit('DAD3_1')).toMatchObject({ moved: false, status: 400, missing: ['Back'] })
    expect((await loadTask('DAD3_1'))!.task.status).toBe('REJECTED')
    expect(await agentSubmit('DAD2_1')).toMatchObject({ moved: false, status: 409 })
    expect(await agentSubmit('NOPE_1')).toMatchObject({ moved: false, status: 404 })
  })

  it('reopen: an unsent approved task goes back to DOING and the line is no longer done', async () => {
    expect(await agentReopenTask('DAD4_1', { note: 'theo yêu cầu' }, { allowSent: false })).toEqual({ status: 'DOING', sent: false })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o4.orderId } })).designReady).toBe(false)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { taskKey: 'DAD4_1' } })).assigneeId).toBeNull()
    expect(await agentReopenTask('DAD4_1', { note: 'lần nữa' }, { allowSent: false })).toEqual({ status: 'DOING', sent: false })
    expect(await agentTaskState('DAD4_1')).toMatchObject({ taskKey: 'DAD4_1', status: 'DOING', sent: false, orderNumber: '#DAD4' })
  })

  it('reopen: a sent line only with allowSent, through the line-fix path, without a new FIX job', async () => {
    await saveAgentSettings({ autoFixOnReject: true })
    const fix = { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }
    await expect(agentReopenTask('DAD5_1', fix, { allowSent: false })).rejects.toMatchObject({ status: 409, message: 'Đơn đã gửi xưởng — cần mở lại trên tool với lý do' })
    expect(await agentReopenTask('DAD5_1', fix, { allowSent: true })).toEqual({ status: 'REJECTED', sent: true })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD5_1' } })).toBe(0)
    await expect(agentReopenTask('DAD6_1', { reason: 'không có', note: 'x' }, { allowSent: true })).rejects.toMatchObject({ status: 400 })
    expect(await agentReopenTask('DAD7_1', fix, { allowSent: true })).toMatchObject({ status: 'REJECTED', sent: true })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD7_1' } })).toBe(0)
    await expect(agentReopenTask('DAD999_1', fix, { allowSent: true })).rejects.toMatchObject({ status: 404 })
  })

  it('reopen: a fulfilled, cancelled or refunded order is refused and left as it is', async () => {
    const fix = { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }
    const closed = { status: 409, message: 'Đơn đã giao hoặc đã đóng — Agent không sửa nữa' }
    expect(await agentTaskState('DAD12_1')).toMatchObject({ orderOpen: false })
    await expect(agentReopenTask('DAD12_1', { note: 'x' }, { allowSent: false })).rejects.toMatchObject(closed)
    await expect(agentReopenTask('DAD13_1', fix, { allowSent: true })).rejects.toMatchObject(closed)
    await expect(agentReopenTask('DAD14_1', fix, { allowSent: true })).rejects.toMatchObject(closed)
    expect((await loadTask('DAD12_1'))!.task.status).toBe('DONE')
    expect((await loadTask('DAD13_1'))!.task.status).toBe('DONE')
  })

  it('reject from review as Design Agent queues nothing by itself', async () => {
    await agentRejectReview('DAD8_1', { reason: 'Khác: sao trên mũ lệch', note: 'Theo yêu cầu của Lan trên Lark' })
    expect((await loadTask('DAD8_1'))!.task).toMatchObject({ status: 'REJECTED', rejectReasons: ['Khác: sao trên mũ lệch'], rejectNote: 'Theo yêu cầu của Lan trên Lark' })
    expect(await lastEvent('DAD8_1')).toMatchObject({ type: 'REJECT', message: 'Trả lại sửa: Khác: sao trên mũ lệch — Theo yêu cầu của Lan trên Lark', actorName: 'Design Agent' })
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD8_1' } })).toBe(0)
    await expect(agentRejectReview('DAD8_1', { reason: 'Khác: x y z', note: 'n' })).rejects.toMatchObject({ status: 409 })
    await expect(agentRejectReview('NOPE_1', { reason: 'Khác: x y z', note: 'n' })).rejects.toMatchObject({ status: 404 })
  })

  it('note and hold', async () => {
    await agentAddNote('DAD1_1', '  vòng 1 chưa đạt ')
    expect((await lastEvent('DAD1_1')).message).toBe('Agent: vòng 1 chưa đạt')
    await expect(agentAddNote('NOPE_1', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(agentAddNote('DAD1_1', '   ')).rejects.toMatchObject({ status: 400 })
    await saveAgentSettings({ autoFixOnReject: false })
    expect(await agentHold('DAD10_1', 'tên vượt khung')).toEqual({ jobId: null })
    expect((await lastEvent('DAD10_1')).message).toBe('Auto render giữ lại: tên vượt khung')
    await saveAgentSettings({ autoFixOnReject: true })
    const { jobId } = await agentHold('DAD11_1', 'chạm safe zone')
    expect(await rowOf(jobId!)).toMatchObject({ kind: 'FIX', source: 'AUTO_HOLD', requestText: 'Auto render giữ lại: chạm safe zone', requestedBy: 'Auto render' })
    await expect(agentHold('NOPE_1', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(agentHold('DAD11_1', ' ')).rejects.toMatchObject({ status: 400 })
  })

  it('a repeated hold does not repeat its note', async () => {
    const notes = async (key: string, message: string) =>
      prisma.designTaskEvent.count({ where: { taskId: await taskId(key), type: 'NOTE', message } })
    await saveAgentSettings({ autoFixOnReject: false })
    expect(await agentHold('DAD10_1', 'lặp lại một lý do')).toEqual({ jobId: null })
    expect(await agentHold('DAD10_1', 'lặp lại một lý do')).toEqual({ jobId: null })
    expect(await notes('DAD10_1', 'Auto render giữ lại: lặp lại một lý do')).toBe(1)
    expect(await agentHold('DAD10_1', 'lý do khác')).toEqual({ jobId: null })
    expect(await notes('DAD10_1', 'Auto render giữ lại: lý do khác')).toBe(1)
    await saveAgentSettings({ autoFixOnReject: true })
    const a = await agentHold('DAD11_1', 'lặp lại khi bật')
    const b = await agentHold('DAD11_1', 'lặp lại khi bật')
    expect(a.jobId).toBeTruthy()
    expect(b.jobId).toBe(a.jobId)
    expect(await notes('DAD11_1', 'Auto render giữ lại: lặp lại khi bật')).toBe(1)
    expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD11_1', source: 'AUTO_HOLD', status: { in: ['QUEUED', 'RUNNING'] } } })).toBe(1)
  })
})
