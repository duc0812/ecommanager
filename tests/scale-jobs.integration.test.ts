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
const editSchema = { type: 'object', required: ['prompt', 'input_urls', 'aspect_ratio'], properties: { prompt: { type: 'string' }, input_urls: { type: 'array', items: { type: 'string' } }, aspect_ratio: { type: 'string', enum: ['1:1', '2:3'] }, resolution: { type: 'string', enum: ['1K', '2K', '4K'] } } }
const design = { sourceGarment: 'varsity jacket', base: 'black with stars', front: 'a figure on a hill', back: 'a poster graphic', sleeves: null, otherParts: null, texts: [{ text: 'MAY THE 4TH', where: 'the back', side: 'back' }] }
const brokenFetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
let partPng: Buffer
const downloadFetch = (async () => new Response(partPng, { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch
const done = (n: number): PollResult => ({ state: 'done', urls: [`https://tempfile.redpandaai.co/result-${n}.png`], credits: 10, costTime: null })

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
    vision: { describe: async (p: any) => { log.push(['vision', p]); return design as any } },
    settings: { ...DEFAULT_SCALE_SETTINGS, allowFallback: opts.allowFallback ?? false },
    visionModel: 'gpt-6.1-sol',
    fetchImpl: downloadFetch,
  }
  return { deps, log, creates: () => log.filter(l => l[0] === 'create'), count: (kind: string) => log.filter(l => l[0] === kind).length }
}

let tmp: string
let targetId: string
let cloakId: string
const clean = async () => {
  await prisma.scaleJob.deleteMany({})
  const mine = await prisma.scaleTarget.findMany({ where: { sku: { startsWith: 'JOBT' } }, select: { id: true } })
  await prisma.scaleTargetView.deleteMany({ where: { targetId: { in: mine.map(t => t.id) } } })
  await prisma.scaleTarget.deleteMany({ where: { sku: { startsWith: 'JOBT' } } })
}
async function makeTarget(sku: string, name: string, views: { label: string; side: 'front' | 'back' }[]) {
  const t = await createTarget({ name, sku })
  for (const v of views) {
    const view = await createView(t.id, v)
    await setViewBlank(view.id, PNG)
    await updateView(view.id, { blankDescription: `${v.label} view of the blank.`, unprintedParts: 'The ribbing' })
  }
  await updateTarget(t.id, { active: true })
  return t.id
}
const run = async (id: string, deps: ScaleDeps) => (await runPipeline(id, deps))!
const start = (deps: ScaleDeps, userId = 'user-a', id = targetId) => createScaleJob({ targetId: id, image: { dataUrl: PNG, name: 'jacket.png' }, userId }, deps, { run: false })
const views = (job: { viewsJson: string }) => JSON.parse(job.viewsJson) as any[]

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-jobs-'))
  process.env.DESIGN_STORAGE_DIR = tmp
  process.env.SCALE_RETRY_DELAY_MS = '0'
  partPng = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#3355aa' } }).png().toBuffer()
  await clean()
  targetId = await makeTarget('JOBT1', 'Test Fleece Zip Hoodie', [{ label: 'Front', side: 'front' }, { label: 'Back', side: 'back' }])
  cloakId = await makeTarget('JOBT3', 'Test Cloak', [{ label: 'Back spread', side: 'back' }, { label: 'Back hood up', side: 'back' }])
})
afterAll(async () => {
  await clean()
  await fs.rm(tmp, { recursive: true, force: true })
})
beforeEach(async () => { await prisma.scaleJob.deleteMany({}) })

describe('scale jobs', () => {
  it('generates each view on its own and joins the finished views into one image', async () => {
    const { deps, log, creates } = fakeDeps({ polls: { 'task-1': [{ state: 'running' }, done(1)], 'task-2': [done(2)] } })
    const job = await start(deps)
    expect(job).toMatchObject({ status: 'describing', targetName: 'Test Fleece Zip Hoodie', model: 'gpt-image-2-5-flare-image-to-image', sourceFile: 'src.png', createdBy: 'user-a' })
    const running = await run(job.id, deps)
    expect(running.status).toBe('running')
    expect(log.filter(l => l[0] === 'vision')).toHaveLength(1)
    expect(log.filter(l => l[0] === 'upload').map(l => l[1])).toEqual([`scale-${job.id}-src.png`, `scale-${job.id}-blank-0.png`, `scale-${job.id}-blank-1.png`])
    expect(creates()).toHaveLength(2)
    const [frontTask, backTask] = creates()
    expect(frontTask[2].input_urls).toEqual([`https://tempfile.redpandaai.co/scale-${job.id}-src.png`, `https://tempfile.redpandaai.co/scale-${job.id}-blank-0.png`])
    expect(frontTask[2]).toMatchObject({ aspect_ratio: '2:3', resolution: '2K' })
    expect(frontTask[2].prompt).toContain('Use only the FRONT artwork of IMAGE 1')
    expect(frontTask[2].prompt).toContain('a figure on a hill')
    expect(frontTask[2].prompt).not.toContain('MAY THE 4TH')
    expect(backTask[2].input_urls[1]).toBe(`https://tempfile.redpandaai.co/scale-${job.id}-blank-1.png`)
    expect(backTask[2].prompt).toContain('Use only the BACK artwork of IMAGE 1')
    expect(backTask[2].prompt).toContain("the text 'MAY THE 4TH' on the back")
    expect(views(running).map(v => [v.label, v.status])).toEqual([['Front', 'running'], ['Back', 'running']])

    const half = await refreshScaleJob(job.id, deps)
    expect(half.status).toBe('running')
    expect(views(half).map(v => v.status)).toEqual(['running', 'done'])
    const finished = await refreshScaleJob(job.id, deps)
    expect(finished).toMatchObject({ status: 'done', resultFile: 'out.jpg', cost: '20 credits', error: null })
    const out = await readScaleFile('jobs', job.id, 'out.jpg')
    const meta = await sharp(out!.bytes).metadata()
    expect(meta.width).toBe(meta.height)
    expect((await readScaleFile('jobs', job.id, 'part-0.png'))?.bytes.length).toBe(partPng.length)
  })

  it('a second view of the same side waits for the first and copies its finished design', async () => {
    const { deps, creates, log } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [done(2)] } })
    const job = await run((await start(deps, 'user-a', cloakId)).id, deps)
    expect(creates()).toHaveLength(1)
    expect(views(job).map(v => v.status)).toEqual(['running', 'waiting'])
    const afterFirst = await refreshScaleJob(job.id, deps)
    expect(afterFirst.status).toBe('running')
    expect(creates()).toHaveLength(2)
    const second = creates()[1]
    expect(second[2].prompt).toContain('IMAGE 1 is a finished mockup of this same printed garment')
    expect(second[2].input_urls).toEqual([`https://tempfile.redpandaai.co/scale-${job.id}-part-0.png`, `https://tempfile.redpandaai.co/scale-${job.id}-blank-1.png`])
    expect(log.filter(l => l[0] === 'upload').map(l => l[1])).toContain(`scale-${job.id}-part-0.png`)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', cost: '20 credits' })
  })

  it('waits and tries again when Kie says the call frequency is too high', async () => {
    const { deps, creates } = fakeDeps()
    let schemaCalls = 0
    let createCalls = 0
    const realCreate = deps.image!.createTask
    deps.image!.schema = async () => { schemaCalls += 1; if (schemaCalls === 1) throw new Error('kie schema 429: Your call frequency is too high. Please try again later.'); return { input: editSchema, root: {} } }
    deps.image!.createTask = async (m, i) => { createCalls += 1; if (createCalls === 1) throw new Error('kie createTask 429: Your call frequency is too high. Please try again later.'); return realCreate(m, i) }
    const job = await run((await start(deps)).id, deps)
    expect(job).toMatchObject({ status: 'running', error: null })
    expect(creates()).toHaveLength(2)
    const dead = fakeDeps()
    dead.deps.image!.createTask = async () => { throw new Error('kie createTask 429: Your call frequency is too high. Please try again later.') }
    expect((await run((await start(dead.deps)).id, dead.deps)).error).toBe('Kie đang giới hạn tốc độ gọi (429), đợi một lát rồi bấm Tạo lại')
  })

  it('refuses a target that is not ready, before anything is uploaded', async () => {
    const { deps, count } = fakeDeps()
    const off = await createTarget({ name: 'Not ready', sku: 'JOBT2' })
    await expect(createScaleJob({ targetId: off.id, image: { dataUrl: PNG, name: 'a.png' } }, deps, { run: false })).rejects.toThrow('Sản phẩm đích chưa sẵn sàng')
    await expect(createScaleJob({ targetId: 'nope', image: { dataUrl: PNG, name: 'a.png' } }, deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
    await expect(createScaleJob({ targetId, image: { dataUrl: 'data:text/plain;base64,aGk=', name: 'a.txt' } }, deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
    expect(count('upload')).toBe(0)
    expect(await prisma.scaleJob.count()).toBe(0)
  })

  it('fails the job when the target was switched off between the click and the run', async () => {
    const { deps, count } = fakeDeps()
    const job = await start(deps)
    await updateTarget(targetId, { active: false })
    const failed = await run(job.id, deps)
    await updateTarget(targetId, { active: true })
    expect(failed).toMatchObject({ status: 'failed', error: 'Sản phẩm đích chưa sẵn sàng' })
    expect(count('create')).toBe(0)
  })

  it('names the CS key when the vision model is refused and the Creative key when the image model is', async () => {
    const a = fakeDeps()
    a.deps.vision!.describe = async () => { throw new Error('kie error 401: The API key is not authorized to use this model.') }
    expect(await run((await start(a.deps)).id, a.deps)).toMatchObject({ status: 'failed', error: 'Key Kie (CS) chưa được cấp quyền model gpt-6.1-sol', designJson: null })
    const b = fakeDeps()
    b.deps.image!.createTask = async () => { throw new Error('kie createTask 401: The API key is not authorized to use this model.') }
    const failed = await run((await start(b.deps)).id, b.deps)
    expect(failed.error).toBe('Key Kie (Creative) chưa được cấp quyền model gpt-image-2-5-flare-image-to-image')
    expect(JSON.parse(failed.designJson!)).toEqual(design)
    expect((await run((await start(a.deps)).id, { ...a.deps, vision: null })).error).toBe('Chưa có API key Kie cho bước đọc ảnh')
    expect((await run((await start(b.deps)).id, { ...b.deps, image: null })).error).toBe('Chưa có API key Kie cho bước tạo ảnh')
  })

  it('fails the whole job and says which view when one view is rejected', async () => {
    const { deps } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [{ state: 'failed', error: 'flagged as sensitive' }] } })
    const job = await run((await start(deps)).id, deps)
    const failed = await refreshScaleJob(job.id, deps)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Back: Kie từ chối nội dung của góc này (bộ lọc kiểm duyệt của model): flagged as sensitive')
  })

  it('re-makes only the rejected view and keeps the views that were already paid for', async () => {
    const { deps, creates, log } = fakeDeps({ polls: { 'task-1': [{ state: 'failed', error: 'The input or output was flagged as sensitive.' }], 'task-2': [done(2)], 'task-3': [done(3)] } })
    const job = await run((await start(deps)).id, deps)
    const failed = await refreshScaleJob(job.id, deps)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Front: Kie từ chối nội dung của góc này (bộ lọc kiểm duyệt của model): The input or output was flagged as sensitive.')
    expect(views(failed).map(v => v.status)).toEqual(['failed', 'done'])
    expect((scaleJobView(failed) as any).canRetryViews).toBe(true)

    const again = await retryFailedViews(job.id, deps)
    expect(again).toMatchObject({ id: job.id, status: 'running', error: null, completedAt: null })
    expect(creates()).toHaveLength(3)
    expect(creates()[2][2].prompt).toContain('Use only the FRONT artwork of IMAGE 1')
    expect(log.filter(l => l[0] === 'vision')).toHaveLength(1)
    expect(views(again).map(v => v.status)).toEqual(['running', 'done'])
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', resultFile: 'out.jpg', cost: '20 credits' })
    await expect(retryFailedViews(job.id, deps)).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('still collects a view that was running when another view failed', async () => {
    const { deps } = fakeDeps({ polls: { 'task-1': [{ state: 'failed', error: 'rejected' }], 'task-2': [{ state: 'running' }, done(2)], 'task-3': [done(3)] } })
    const job = await run((await start(deps)).id, deps)
    const failed = await refreshScaleJob(job.id, deps)
    expect(views(failed).map(v => v.status)).toEqual(['failed', 'running'])
    await retryFailedViews(job.id, deps)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', cost: '20 credits' })
  })

  it('keeps a job running through a poll error and retries a failed download', async () => {
    const { deps } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [done(2)] } })
    const job = await run((await start(deps)).id, deps)
    const flaky = { ...deps, image: { ...deps.image!, poll: async () => { throw new Error('timeout') } } }
    expect(await refreshScaleJob(job.id, flaky)).toMatchObject({ status: 'running', error: 'Poll lỗi: timeout' })
    const pending = await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    expect(pending.status).toBe('running')
    expect(views(pending).every(v => v.status === 'running' && v.resultUrl)).toBe(true)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', resultFile: 'out.jpg', cost: '20 credits' })
  })

  it('gives up on an interrupted or never-ending job', async () => {
    const { deps } = fakeDeps({ polls: { 'task-1': [done(1)], 'task-2': [done(2)] } })
    const stuck = await start(deps)
    expect((await refreshScaleJob(stuck.id, deps)).status).toBe('describing')
    await prisma.scaleJob.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } })
    expect(await refreshScaleJob(stuck.id, deps)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })

    const job = await run((await start(deps)).id, deps)
    await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    await prisma.scaleJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } })
    const gone = await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    expect(gone.status).toBe('failed')
    expect(gone.error).toContain('Quá 30 phút')
  })

  it('does not start paid tasks when the job was closed or deleted while the design was being read', async () => {
    const a = fakeDeps()
    const closed = await start(a.deps)
    a.deps.vision!.describe = async () => { await prisma.scaleJob.update({ where: { id: closed.id }, data: { status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' } }); return design as any }
    expect(await runPipeline(closed.id, a.deps)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })
    expect(a.count('create')).toBe(0)
    const b = fakeDeps()
    const deleted = await start(b.deps)
    b.deps.vision!.describe = async () => { await prisma.scaleJob.delete({ where: { id: deleted.id } }); return design as any }
    await expect(runPipeline(deleted.id, b.deps)).resolves.toBeNull()
    expect(b.count('create')).toBe(0)
  })

  it('never uses the fallback model unless the owner switched it on, and reuses the design when it does', async () => {
    const off = fakeDeps({ polls: { 'task-1': [{ state: 'failed', error: 'rejected' }], 'task-2': [done(2)] } })
    const job = await run((await start(off.deps)).id, off.deps)
    await refreshScaleJob(job.id, off.deps)
    await expect(fallbackScaleJob(job.id, 'user-b', off.deps, { run: false })).rejects.toThrow('Chưa bật model dự phòng')
    expect(await prisma.scaleJob.count()).toBe(1)
    const on = fakeDeps({ allowFallback: true })
    const next = await fallbackScaleJob(job.id, 'user-b', on.deps, { run: false })
    expect(next).toMatchObject({ model: 'seedream/4.5-edit', parentJobId: job.id, status: 'describing', createdBy: 'user-b', sourceFile: 'src.png' })
    expect((await run(next.id, on.deps)).status).toBe('running')
    expect(on.count('vision')).toBe(0)
    expect(on.creates().every(c => c[1] === 'seedream/4.5-edit')).toBe(true)
    const fresh = await run((await start(on.deps)).id, on.deps)
    await expect(fallbackScaleJob(fresh.id, 'user-a', on.deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
  })

  it('re-runs with the same source and a fresh reading of the design', async () => {
    const { deps, count } = fakeDeps()
    const job = await run((await start(deps)).id, deps)
    const again = await rerunScaleJob(job.id, 'user-b', deps, { run: false })
    expect(again).toMatchObject({ parentJobId: job.id, designJson: null, sourceFile: 'src.png', model: 'gpt-image-2-5-flare-image-to-image' })
    await run(again.id, deps)
    expect(count('vision')).toBe(2)
    expect((await listScaleJobs()).map(j => j.id)).toEqual([again.id, job.id])
  })

  it('lets only the creator or a superadmin delete a job, and removes its files', async () => {
    const { deps } = fakeDeps()
    const job = await start(deps, 'user-a')
    await expect(deleteScaleJob(job.id, { id: 'user-b', role: 'SELLER' })).rejects.toThrow('Chỉ người tạo hoặc superadmin được xóa')
    await deleteScaleJob(job.id, { id: 'user-a', role: 'SELLER' })
    expect(await prisma.scaleJob.findUnique({ where: { id: job.id } })).toBeNull()
    await expect(fs.stat(path.join(scaleRoot(), 'jobs', job.id))).rejects.toThrow()
    const other = await start(deps, 'user-a')
    await deleteScaleJob(other.id, { id: 'boss', role: 'SUPERADMIN' })
    expect(await prisma.scaleJob.count()).toBe(0)
  })

  it('never hands out the prompt, the design description or provider task details', async () => {
    const { deps } = fakeDeps()
    const job = await run((await start(deps)).id, deps)
    const view: any = scaleJobView(job)
    expect(view.prompt).toBeUndefined()
    expect(view.designJson).toBeUndefined()
    expect(view.viewsJson).toBeUndefined()
    expect(view.hasDesign).toBe(true)
    expect(view.views).toEqual([{ label: 'Front', status: 'running' }, { label: 'Back', status: 'running' }])
    expect(JSON.stringify(view)).not.toContain('Keep IMAGE 2 EXACTLY')
    expect(JSON.stringify(view)).not.toContain('task-1')
  })
})
