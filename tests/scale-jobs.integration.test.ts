import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { prisma } from '@/lib/db'
import type { PollResult } from '@/lib/creative/kie'
import { DEFAULT_SCALE_SETTINGS, ScaleInputError, type ScaleDeps } from '@/lib/scale/settings'
import { readScaleFile, scaleRoot } from '@/lib/scale/storage'
import { createTarget, setBlank, updateTarget } from '@/lib/scale/targets'
import { createScaleJob, deleteScaleJob, fallbackScaleJob, listScaleJobs, refreshScaleJob, rerunScaleJob, runPipeline, scaleJobView } from '@/lib/scale/jobs'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const editSchema = { type: 'object', required: ['prompt', 'input_urls', 'aspect_ratio'], properties: { prompt: { type: 'string' }, input_urls: { type: 'array', items: { type: 'string' } }, aspect_ratio: { type: 'string', enum: ['16:9', '1:1'] }, resolution: { type: 'string', enum: ['1K', '2K', '4K'] } } }
const design = { sourceGarment: 'varsity jacket', base: 'black with stars', front: 'a figure on a hill', back: null, sleeves: null, otherParts: null, texts: [{ text: 'MAY THE 4TH', where: 'the back' }] }
const downloadFetch = (async () => new Response(Buffer.from('result-bytes'), { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as typeof fetch
const brokenFetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch

function fakeDeps(opts: { polls?: PollResult[]; allowFallback?: boolean } = {}) {
  const log: any[] = []
  const polls = opts.polls ?? [{ state: 'running' as const }]
  let pollIdx = 0
  const deps: ScaleDeps = {
    image: {
      schema: async () => ({ input: editSchema, root: {} }),
      uploadBase64: async (_d: string, name: string) => { log.push(['upload', name]); return `https://tempfile.redpandaai.co/${name}` },
      createTask: async (model: string, input: Record<string, unknown>) => { log.push(['create', model, input]); return 'task-1' },
      poll: async () => polls[Math.min(pollIdx++, polls.length - 1)],
    },
    vision: { describe: async (p: any) => { log.push(['vision', p]); return design as any } },
    settings: { ...DEFAULT_SCALE_SETTINGS, allowFallback: opts.allowFallback ?? false },
    visionModel: 'gpt-6.1-sol',
    fetchImpl: downloadFetch,
  }
  return { deps, log, count: (kind: string) => log.filter(l => l[0] === kind).length }
}

let tmp: string
let targetId: string
const clean = async () => {
  await prisma.scaleJob.deleteMany({})
  await prisma.scaleTarget.deleteMany({ where: { sku: { startsWith: 'JOBT' } } })
}
const run = async (id: string, deps: ScaleDeps) => (await runPipeline(id, deps))!
const start = (deps: ScaleDeps, userId = 'user-a') => createScaleJob({ targetId, image: { dataUrl: PNG, name: 'jacket.png' }, userId }, deps, { run: false })

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scale-jobs-'))
  process.env.DESIGN_STORAGE_DIR = tmp
  await clean()
  const t = await createTarget({ name: 'Test Fleece Zip Hoodie', sku: 'JOBT1' })
  await setBlank(t.id, PNG)
  await updateTarget(t.id, { blankDescription: 'front view on the left, back view on the right.', unprintedParts: 'The ribbing and zipper', active: true })
  targetId = t.id
})
afterAll(async () => {
  await clean()
  await fs.rm(tmp, { recursive: true, force: true })
})
beforeEach(async () => { await prisma.scaleJob.deleteMany({}) })

describe('scale jobs', () => {
  it('reads the design, sends source then blank under per-job names, and saves the finished image', async () => {
    const { deps, log } = fakeDeps({ polls: [{ state: 'running' }, { state: 'done', urls: ['https://tempfile.redpandaai.co/out.png'], credits: 12, costTime: null }] })
    const job = await start(deps)
    expect(job).toMatchObject({ status: 'describing', targetName: 'Test Fleece Zip Hoodie', model: 'gpt-image-2-5-flare-image-to-image', sourceFile: 'src.png', createdBy: 'user-a' })
    const running = await run(job.id, deps)
    expect(running).toMatchObject({ status: 'running', providerTaskId: 'task-1' })
    expect(log.filter(l => l[0] === 'upload').map(l => l[1])).toEqual([`scale-${job.id}-src.png`, `scale-${job.id}-blank.png`])
    const vision = log.find(l => l[0] === 'vision')[1]
    expect(vision).toMatchObject({ model: 'gpt-6.1-sol', schemaName: 'scale_design' })
    expect(vision.images).toEqual([PNG])
    expect(vision.text).toContain('Test Fleece Zip Hoodie')
    const create = log.find(l => l[0] === 'create')
    expect(create[1]).toBe('gpt-image-2-5-flare-image-to-image')
    expect(create[2].input_urls).toEqual([`https://tempfile.redpandaai.co/scale-${job.id}-src.png`, `https://tempfile.redpandaai.co/scale-${job.id}-blank.png`])
    expect(create[2]).toMatchObject({ aspect_ratio: '1:1', resolution: '2K' })
    expect(create[2].prompt).toContain('Keep IMAGE 2 EXACTLY')
    expect(create[2].prompt).toContain("the text 'MAY THE 4TH' on the back")
    expect(create[2].prompt).toContain('Back view: continues the same base pattern with no additional graphic.')
    expect(JSON.parse(running.designJson!)).toEqual(design)

    expect((await refreshScaleJob(job.id, deps)).status).toBe('running')
    const done = await refreshScaleJob(job.id, deps)
    expect(done).toMatchObject({ status: 'done', resultFile: 'out.png', cost: '12 credits', error: null })
    expect((await readScaleFile('jobs', job.id, 'out.png'))?.bytes.toString()).toBe('result-bytes')
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

  it('names the CS key when the vision model is refused', async () => {
    const { deps, count } = fakeDeps()
    deps.vision!.describe = async () => { throw new Error('kie error 401: The API key is not authorized to use this model.') }
    const failed = await run((await start(deps)).id, deps)
    expect(failed).toMatchObject({ status: 'failed', error: 'Key Kie (CS) chưa được cấp quyền model gpt-6.1-sol', designJson: null })
    expect(count('create')).toBe(0)
  })

  it('names the Creative key when the image model is refused and keeps the design for a later fallback', async () => {
    const { deps } = fakeDeps()
    deps.image!.createTask = async () => { throw new Error('kie createTask 401: The API key is not authorized to use this model.') }
    const failed = await run((await start(deps)).id, deps)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('Key Kie (Creative) chưa được cấp quyền model gpt-image-2-5-flare-image-to-image')
    expect(JSON.parse(failed.designJson!)).toEqual(design)
  })

  it('says which step has no key', async () => {
    const { deps } = fakeDeps()
    expect((await run((await start(deps)).id, { ...deps, vision: null })).error).toBe('Chưa có API key Kie cho bước đọc ảnh')
    expect((await run((await start(deps)).id, { ...deps, image: null })).error).toBe('Chưa có API key Kie cho bước tạo ảnh')
  })

  it('shows the provider message when the image step fails', async () => {
    const { deps } = fakeDeps({ polls: [{ state: 'failed', error: 'Your request was rejected by the safety system' }] })
    const job = await run((await start(deps)).id, deps)
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'failed', error: 'Your request was rejected by the safety system' })
  })

  it('keeps a job running through a poll error and retries a failed download', async () => {
    const { deps } = fakeDeps({ polls: [{ state: 'done', urls: ['https://tempfile.redpandaai.co/out.png'], credits: 3, costTime: null }] })
    const job = await run((await start(deps)).id, deps)
    const flaky = { ...deps, image: { ...deps.image!, poll: async () => { throw new Error('timeout') } } }
    expect(await refreshScaleJob(job.id, flaky)).toMatchObject({ status: 'running', error: 'Poll lỗi: timeout' })
    const pending = await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    expect(pending).toMatchObject({ status: 'running', resultUrl: 'https://tempfile.redpandaai.co/out.png' })
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'done', resultFile: 'out.png', cost: '3 credits' })
  })

  it('gives up on a job that was interrupted while reading the design', async () => {
    const { deps } = fakeDeps()
    const job = await start(deps)
    expect((await refreshScaleJob(job.id, deps)).status).toBe('describing')
    await prisma.scaleJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } })
    expect(await refreshScaleJob(job.id, deps)).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })
  })

  it('does not start a paid task when the job was closed while the design was being read', async () => {
    const { deps, count } = fakeDeps()
    const job = await start(deps)
    deps.vision!.describe = async () => {
      await prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' } })
      return design as any
    }
    const after = await run(job.id, deps)
    expect(after).toMatchObject({ status: 'failed', error: 'Bị gián đoạn, bấm Tạo lại' })
    expect(count('create')).toBe(0)
    expect(count('upload')).toBe(0)
  })

  it('stops quietly when the job was deleted while the design was being read', async () => {
    const { deps, count } = fakeDeps()
    const job = await start(deps)
    deps.vision!.describe = async () => { await prisma.scaleJob.delete({ where: { id: job.id } }); return design as any }
    await expect(runPipeline(job.id, deps)).resolves.toBeNull()
    expect(count('create')).toBe(0)
  })

  it('gives up on a finished job whose result can no longer be downloaded', async () => {
    const { deps } = fakeDeps({ polls: [{ state: 'done', urls: ['https://tempfile.redpandaai.co/out.png'], credits: 3, costTime: null }] })
    const job = await run((await start(deps)).id, deps)
    await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    await prisma.scaleJob.update({ where: { id: job.id }, data: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } })
    const gone = await refreshScaleJob(job.id, { ...deps, fetchImpl: brokenFetch })
    expect(gone.status).toBe('failed')
    expect(gone.error).toContain('Quá 30 phút')
  })

  it('never uses the fallback model unless the owner switched it on', async () => {
    const off = fakeDeps({ polls: [{ state: 'failed', error: 'rejected' }] })
    const job = await run((await start(off.deps)).id, off.deps)
    await refreshScaleJob(job.id, off.deps)
    await expect(fallbackScaleJob(job.id, 'user-b', off.deps, { run: false })).rejects.toThrow('Chưa bật model dự phòng')
    expect(await prisma.scaleJob.count()).toBe(1)

    const on = fakeDeps({ allowFallback: true })
    const next = await fallbackScaleJob(job.id, 'user-b', on.deps, { run: false })
    expect(next).toMatchObject({ model: 'seedream/4.5-edit', parentJobId: job.id, status: 'describing', createdBy: 'user-b', sourceFile: 'src.png' })
    const running = await run(next.id, on.deps)
    expect(running.status).toBe('running')
    expect(on.count('vision')).toBe(0)
    expect(on.log.find(l => l[0] === 'create')[1]).toBe('seedream/4.5-edit')
    expect(on.log.filter(l => l[0] === 'upload').map(l => l[1])).toEqual([`scale-${next.id}-src.png`, `scale-${next.id}-blank.png`])
  })

  it('only offers the fallback for a failed job that already has a design', async () => {
    const { deps } = fakeDeps({ allowFallback: true })
    const job = await run((await start(deps)).id, deps)
    await expect(fallbackScaleJob(job.id, 'user-a', deps, { run: false })).rejects.toBeInstanceOf(ScaleInputError)
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

  it('hides the prompt and the design from staff', async () => {
    const { deps } = fakeDeps()
    const job = await run((await start(deps)).id, deps)
    const staff: any = scaleJobView(job, { debug: false })
    expect(staff.prompt).toBeUndefined()
    expect(staff.designJson).toBeUndefined()
    expect(staff.hasDesign).toBe(true)
    expect((scaleJobView(job, { debug: true }) as any).prompt).toContain('Keep IMAGE 2 EXACTLY')
  })
})
