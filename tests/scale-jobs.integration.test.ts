import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { prisma } from '@/lib/db'
import type { PollResult } from '@/lib/creative/kie'
import { DEFAULT_SCALE_SETTINGS, ScaleInputError, type ScaleDeps } from '@/lib/scale/settings'
import { readScaleFile, scaleRoot } from '@/lib/scale/storage'
import { createTarget, createView, setViewBlank, updateTarget, updateView } from '@/lib/scale/targets'
import { createScaleJob, deleteScaleJob, fallbackScaleJob, listScaleJobs, refreshScaleJob, rerunScaleJob, retryFailedViews, runPipeline, scaleJobView } from '@/lib/scale/jobs'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const editSchema = { type: 'object', required: ['prompt', 'input_urls', 'aspect_ratio'], properties: { prompt: { type: 'string' }, input_urls: { type: 'array', items: { type: 'string' } }, aspect_ratio: { type: 'string', enum: ['1:1', '2:3', '3:2'] }, resolution: { type: 'string', enum: ['1K', '2K', '4K'] } } }
const brokenFetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
let partPng: Buffer
const downloadFetch = (async () => new Response(new Uint8Array(partPng), { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch
const done = (n: number): PollResult => ({ state: 'done', urls: [`https://tempfile.redpandaai.co/result-${n}.png`], credits: 10, costTime: null })
const rejected: PollResult = { state: 'failed', error: 'The input or output was flagged as sensitive.' }
const REFUSED = 'Kie từ chối nội dung của bước này (bộ lọc kiểm duyệt của model): The input or output was flagged as sensitive.'

function fakeDeps(opts: { polls?: Record<string, PollResult[]>; allowFallback?: boolean } = {}) {
  const log: any[] = []
  const pollIdx: Record<string, number> = {}
  let taskNo = 0
  const deps: ScaleDeps = {
    image: {
      schema: async () => ({ input: editSchema, root: {} }),
      uploadBase64: async (_d: string, name: string) => { log.push(['upload', name]); return `https://tempfile.redpandaai.co/${name}` },
      createTask: async (model: string, input: Record<string, unknown>) => { taskNo += 1; log.push(['create', model, input, `task-${taskNo}`]); return `task-${taskNo}` },
      poll: async (taskId: string) => {
        const list = opts.polls?.[taskId] ?? [{ state: 'running' as const }]
        const i = pollIdx[taskId] ?? 0
        pollIdx[taskId] = i + 1
        return list[Math.min(i, list.length - 1)]
      },
    },
    vision: null,
    settings: { ...DEFAULT_SCALE_SETTINGS, allowFallback: opts.allowFallback ?? false },
    visionModel: 'gpt-6.1-sol',
    fetchImpl: downloadFetch,
  }
  return { deps, log, creates: () => log.filter(l => l[0] === 'create'), uploads: () => log.filter(l => l[0] === 'upload').map(l => l[1]), count: (kind: string) => log.filter(l => l[0] === kind).length }
}

let tmp: string
let targetId: string
let splitId: string
const clean = async () => {
  await prisma.scaleJob.deleteMany({})
  const mine = await prisma.scaleTarget.findMany({ where: { sku: { startsWith: 'JOBT' } }, select: { id: true } })
  await prisma.scaleTargetView.deleteMany({ where: { targetId: { in: mine.map(t => t.id) } } })
  await prisma.scaleTarget.deleteMany({ where: { sku: { startsWith: 'JOBT' } } })
}
async function makeTarget(sku: string, name: string, views: { label: string; side: 'both' | 'front' | 'back' }[]) {
  const t = await createTarget({ name, sku })
  for (const v of views) {
    const view = await createView(t.id, v)
    await setViewBlank(view.id, PNG)
    await updateView(view.id, { blankDescription: `${v.label} of the blank.`, unprintedParts: 'The buttons' })
  }
  await updateTarget(t.id, { active: true })
  return t.id
}
const run = async (id: string, deps: ScaleDeps) => (await runPipeline(id, deps))!
const start = (deps: ScaleDeps, userId = 'user-a', id = targetId) => createScaleJob({ targetId: id, image: { dataUrl: PNG, name: 'jacket.png' }, userId }, deps, { run: false })
const steps = (job: { viewsJson: string }) => (JSON.parse(job.viewsJson) as any[]).map(s => `${s.kind}:${s.status}`)

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-jobs-'))
  process.env.DESIGN_STORAGE_DIR = tmp
  process.env.SCALE_RETRY_DELAY_MS = '0'
  partPng = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#3355aa' } }).png().toBuffer()
  await clean()
  targetId = await makeTarget('JOBT1', 'Test Knitted Cardigan', [{ label: 'Trước + sau', side: 'both' }])
  splitId = await makeTarget('JOBT3', 'Test Hoodie', [{ label: 'Front', side: 'front' }, { label: 'Back', side: 'back' }])
})
afterAll(async () => {
  await clean()
  await fs.rm(tmp, { recursive: true, force: true })
})
beforeEach(async () => { await prisma.scaleJob.deleteMany({}) })

describe('scale jobs', () => {
  it('first lays the print out as one pattern sheet, then prints that sheet onto the two-view blank in one go', async () => {
    const { deps, creates, uploads } = fakeDeps({ polls: { 'task-1': [{ state: 'running' }, done(1)], 'task-2': [done(2)] } })
    const job = await start(deps)
    expect(job).toMatchObject({ status: 'describing', targetName: 'Test Knitted Cardigan', model: 'gpt-image-2-5-flare-image-to-image', sourceFile: 'src.png', createdBy: 'user-a' })
    const running = await run(job.id, deps)
    expect(running.status).toBe('running')
    expect(steps(running)).toEqual(['sheet:running', 'view:waiting'])
    expect(uploads()).toEqual([`scale-${job.id}-src.png`])
    expect(creates()).toHaveLength(1)
    expect(creates()[0][2].prompt).toContain('print-pattern layout')
    expect(creates()[0][2]).toMatchObject({ input_urls: [`https://tempfile.redpandaai.co/scale-${job.id}-src.png`], aspect_ratio: '3:2', resolution: '2K' })

    expect(steps(await refreshScaleJob(job.id, deps))).toEqual(['sheet:running', 'view:waiting'])
    const applying = await refreshScaleJob(job.id, deps)
    expect(steps(applying)).toEqual(['sheet:done', 'view:running'])
    expect((await readScaleFile('jobs', job.id, 'sheet.png'))?.bytes.length).toBe(partPng.length)
    expect(uploads().slice(1)).toEqual([`scale-${job.id}-sheet.png`, `scale-${job.id}-blank-0.png`])
    const apply = creates()[1][2]
    expect(apply.input_urls).toEqual([`https://tempfile.redpandaai.co/scale-${job.id}-sheet.png`, `https://tempfile.redpandaai.co/scale-${job.id}-blank-0.png`])
    expect(apply).toMatchObject({ aspect_ratio: '1:1', resolution: '2K' })
    expect(apply.prompt).toContain('IMAGE 1 is a flat print-pattern sheet')
    expect(apply.prompt).toContain('On each FRONT view')
    expect(apply.prompt).toContain('The buttons stay unprinted.')

    const finished = await refreshScaleJob(job.id, deps)
    expect(finished).toMatchObject({ status: 'done', resultFile: 'out.jpg', cost: '20 credits', error: null })
    const meta = await sharp((await readScaleFile('jobs', job.id, 'out.jpg'))!.bytes).metadata()
    expect(meta.width).toBe(meta.height)
  })

  it('a target with separate front and back blanks gets one print job per blank from the same sheet', async () => {
    const { deps, creates } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [done(2)], 'task-3': [done(3)] } })
    const job = await run((await start(deps, 'user-a', splitId)).id, deps)
    const applying = await refreshScaleJob(job.id, deps)
    expect(steps(applying)).toEqual(['sheet:done', 'view:running', 'view:running'])
    expect(creates().slice(1).map(c => c[2].aspect_ratio)).toEqual(['2:3', '2:3'])
    expect(creates()[1][2].prompt).toContain('showing the FRONT of the garment')
    expect(creates()[2][2].prompt).toContain('showing the BACK of the garment')
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', cost: '30 credits' })
  })

  it('refuses a target that is not ready or a file that is not an image, before anything is uploaded', async () => {
    const { deps, count } = fakeDeps()
    const off = await createTarget({ name: 'Not ready', sku: 'JOBT2' })
    await expect(createScaleJob({ targetId: off.id, image: { dataUrl: PNG, name: 'a.png' } }, deps, { run: false })).rejects.toThrow('Sản phẩm đích chưa sẵn sàng')
    await expect(createScaleJob({ targetId: 'nope', image: { dataUrl: PNG, name: 'a.png' } }, deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
    await expect(createScaleJob({ targetId, image: { dataUrl: 'data:text/plain;base64,aGk=', name: 'a.txt' } }, deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
    expect(count('upload')).toBe(0)
    const job = await start(deps)
    await updateTarget(targetId, { active: false })
    const failed = await run(job.id, deps)
    await updateTarget(targetId, { active: true })
    expect(failed).toMatchObject({ status: 'failed', error: 'Sản phẩm đích chưa sẵn sàng' })
    expect(count('create')).toBe(0)
  })

  it('says which key lacks the model, waits out a rate limit, and reports a missing key', async () => {
    const a = fakeDeps()
    a.deps.image!.createTask = async () => { throw new Error('kie createTask 401: The API key is not authorized to use this model.') }
    expect((await run((await start(a.deps)).id, a.deps)).error).toBe('Key Kie (Creative) chưa được cấp quyền model gpt-image-2-5-flare-image-to-image')
    const b = fakeDeps()
    let calls = 0
    const real = b.deps.image!.createTask
    b.deps.image!.createTask = async (m, i) => { calls += 1; if (calls === 1) throw new Error('kie createTask 429: Your call frequency is too high. Please try again later.'); return real(m, i) }
    expect(await run((await start(b.deps)).id, b.deps)).toMatchObject({ status: 'running', error: null })
    const c = fakeDeps()
    c.deps.image!.createTask = async () => { throw new Error('kie createTask 429: Your call frequency is too high. Please try again later.') }
    expect((await run((await start(c.deps)).id, c.deps)).error).toBe('Kie đang giới hạn tốc độ gọi (429), đợi một lát rồi bấm Tạo lại')
    expect((await run((await start(a.deps)).id, { ...a.deps, image: null })).error).toBe('Chưa có API key Kie cho bước tạo ảnh')
  })

  it('when the sheet is rejected, the failed step can be made again without starting a new job', async () => {
    const { deps, creates } = fakeDeps({ polls: { 'task-1': [rejected], 'task-2': [done(2)], 'task-3': [done(3)] } })
    const job = await run((await start(deps)).id, deps)
    const failed = await refreshScaleJob(job.id, deps)
    expect(failed).toMatchObject({ status: 'failed', error: `Tách họa tiết: ${REFUSED}` })
    expect((scaleJobView(failed) as any).canRetryViews).toBe(true)
    const again = await retryFailedViews(job.id, deps)
    expect(again).toMatchObject({ id: job.id, status: 'running', error: null, completedAt: null })
    expect(steps(again)).toEqual(['sheet:running', 'view:waiting'])
    expect(creates()[1][2].prompt).toContain('print-pattern layout')
    await refreshScaleJob(job.id, deps)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', cost: '20 credits' })
    await expect(retryFailedViews(job.id, deps)).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('when the print onto the blank is rejected, only that step is made again and the paid sheet is kept', async () => {
    const { deps, creates } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [rejected], 'task-3': [done(3)] } })
    const job = await run((await start(deps)).id, deps)
    await refreshScaleJob(job.id, deps)
    const failed = await refreshScaleJob(job.id, deps)
    expect(failed).toMatchObject({ status: 'failed', error: `Trước + sau: ${REFUSED}` })
    expect(steps(failed)).toEqual(['sheet:done', 'view:failed'])
    await retryFailedViews(job.id, deps)
    const applying = await refreshScaleJob(job.id, deps)
    expect(steps(applying)).toEqual(['sheet:done', 'view:running'])
    expect(creates()).toHaveLength(3)
    expect(creates()[2][2].prompt).toContain('IMAGE 1 is a flat print-pattern sheet')
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', cost: '20 credits' })
  })

  it('keeps a job running through a poll error and retries a failed download', async () => {
    const { deps } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [done(2)] } })
    const job = await run((await start(deps)).id, deps)
    const flaky = { ...deps, image: { ...deps.image!, poll: async () => { throw new Error('timeout') } } }
    expect(await refreshScaleJob(job.id, flaky)).toMatchObject({ status: 'running', error: 'Poll lỗi: timeout' })
    const pending = await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    expect(pending.status).toBe('running')
    expect(pending.error).toContain('Tải ảnh kết quả lỗi')
    expect(steps(pending)).toEqual(['sheet:running', 'view:waiting'])
    await refreshScaleJob(job.id, deps)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', resultFile: 'out.jpg', cost: '20 credits' })
  })

  it('gives up on an interrupted or never-ending job', async () => {
    const { deps } = fakeDeps()
    const stuck = await start(deps)
    expect((await refreshScaleJob(stuck.id, deps)).status).toBe('describing')
    await prisma.scaleJob.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } })
    expect(await refreshScaleJob(stuck.id, deps)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })
    const job = await run((await start(deps)).id, deps)
    await prisma.scaleJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } })
    const gone = await refreshScaleJob(job.id, deps)
    expect(gone.status).toBe('failed')
    expect(gone.error).toContain('Quá 30 phút')
  })

  it('does not start a paid task when the job was closed or deleted while it was being prepared', async () => {
    const a = fakeDeps()
    const closed = await start(a.deps)
    a.deps.image!.uploadBase64 = async () => { await prisma.scaleJob.update({ where: { id: closed.id }, data: { status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' } }); return 'https://tempfile.redpandaai.co/x.png' }
    expect(await runPipeline(closed.id, a.deps)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })
    expect(a.count('create')).toBe(0)
    const b = fakeDeps()
    const deleted = await start(b.deps)
    b.deps.image!.uploadBase64 = async () => { await prisma.scaleJob.delete({ where: { id: deleted.id } }); return 'https://tempfile.redpandaai.co/x.png' }
    await expect(runPipeline(deleted.id, b.deps)).resolves.toBeNull()
    expect(b.count('create')).toBe(0)
  })

  it('never uses the fallback model unless the owner switched it on, and then reuses the finished sheet', async () => {
    const off = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [rejected] } })
    const job = await run((await start(off.deps)).id, off.deps)
    await refreshScaleJob(job.id, off.deps)
    await refreshScaleJob(job.id, off.deps)
    await expect(fallbackScaleJob(job.id, 'user-b', off.deps, { run: false })).rejects.toThrow('Chưa bật model dự phòng')
    expect(await prisma.scaleJob.count()).toBe(1)
    const on = fakeDeps({ allowFallback: true })
    const next = await fallbackScaleJob(job.id, 'user-b', on.deps, { run: false })
    expect(next).toMatchObject({ model: 'seedream/4.5-edit', parentJobId: job.id, status: 'describing', createdBy: 'user-b', sourceFile: 'src.png' })
    const running = await run(next.id, on.deps)
    expect(steps(running)).toEqual(['sheet:done', 'view:waiting'])
    expect(on.count('create')).toBe(0)
    await refreshScaleJob(next.id, on.deps)
    expect(on.creates()).toHaveLength(1)
    expect(on.creates()[0][1]).toBe('seedream/4.5-edit')
    expect(on.creates()[0][2].prompt).toContain('IMAGE 1 is a flat print-pattern sheet')
    const fresh = await run((await start(on.deps)).id, on.deps)
    await expect(fallbackScaleJob(fresh.id, 'user-a', on.deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('re-runs from scratch with the same source, and lets only the creator or a superadmin delete', async () => {
    const { deps, creates } = fakeDeps()
    const job = await run((await start(deps)).id, deps)
    const again = await rerunScaleJob(job.id, 'user-b', deps, { run: false })
    expect(again).toMatchObject({ parentJobId: job.id, sourceFile: 'src.png', model: 'gpt-image-2-5-flare-image-to-image', viewsJson: '[]' })
    await run(again.id, deps)
    expect(creates().map(c => c[2].prompt.includes('print-pattern layout'))).toEqual([true, true])
    expect((await listScaleJobs()).map(j => j.id)).toEqual([again.id, job.id])
    await expect(deleteScaleJob(job.id, { id: 'user-b', role: 'SELLER' })).rejects.toThrow('Chỉ người tạo hoặc superadmin được xóa')
    await deleteScaleJob(job.id, { id: 'user-a', role: 'SELLER' })
    await expect(fs.stat(path.join(scaleRoot(), 'jobs', job.id))).rejects.toThrow()
    await deleteScaleJob(again.id, { id: 'boss', role: 'SUPERADMIN' })
    expect(await prisma.scaleJob.count()).toBe(0)
  })

  it('never hands out the prompt or provider task details, only the progress of each step', async () => {
    const { deps } = fakeDeps()
    const job = await run((await start(deps)).id, deps)
    const view: any = scaleJobView(job)
    expect(view.prompt).toBeUndefined()
    expect(view.designJson).toBeUndefined()
    expect(view.viewsJson).toBeUndefined()
    expect(view.views).toEqual([{ label: 'Tách họa tiết', status: 'running' }, { label: 'Trước + sau', status: 'waiting' }])
    expect(JSON.stringify(view)).not.toContain('print-pattern')
    expect(JSON.stringify(view)).not.toContain('task-1')
  })
})
