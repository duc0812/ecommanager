import { prisma } from '@/lib/db'
import type { ScaleJob } from '@/generated/prisma/client'
import type { PollResult } from '@/lib/creative/kie'
import { fetchImage } from '@/lib/creative/storage'
import { DesignSchema, buildScalePrompt, designSystemPrompt, designUserText, type Design } from '@/lib/scale/prompt'
import { ScaleInputError, explainKieError, type ScaleDeps } from '@/lib/scale/settings'
import { deleteScaleFolder, readScaleFile, toDataUrl, writeScaleFile } from '@/lib/scale/storage'
import { imageForm, imageInput, isReady, parseImage } from '@/lib/scale/targets'

const DESCRIBE_GIVE_UP_MS = 5 * 60 * 1000
const RUN_GIVE_UP_MS = 30 * 60 * 1000
const NOT_READY = 'Sản phẩm đích chưa sẵn sàng'

export function scaleJobView(j: ScaleJob, opts: { debug: boolean }) {
  const { prompt, designJson, ...rest } = j
  const base = { ...rest, hasDesign: !!designJson }
  return opts.debug ? { ...base, prompt, designJson } : base
}

async function getJob(id: string): Promise<ScaleJob> {
  const job = await prisma.scaleJob.findUnique({ where: { id } })
  if (!job) throw new ScaleInputError('Không tìm thấy job')
  return job
}

async function readyTarget(id: string) {
  const target = await prisma.scaleTarget.findUnique({ where: { id } })
  if (!target || !isReady(target)) throw new ScaleInputError(NOT_READY)
  return target
}

function kick(jobId: string, deps: ScaleDeps, opts?: { run?: boolean }) {
  if (opts?.run !== false) void runPipeline(jobId, deps)
}

export async function createScaleJob(p: { targetId: string; image: { dataUrl: string; name: string }; userId?: string }, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> {
  const target = await readyTarget(String(p.targetId ?? ''))
  const img = parseImage(p.image?.dataUrl)
  const created = await prisma.scaleJob.create({ data: { targetId: target.id, targetName: target.name, model: deps.settings.imageModel, createdBy: p.userId ?? null } })
  const sourceFile = await writeScaleFile('jobs', created.id, 'src', img.bytes, img.ext)
  const job = await prisma.scaleJob.update({ where: { id: created.id }, data: { sourceFile } })
  kick(job.id, deps, opts)
  return job
}

async function cloneJob(from: ScaleJob, data: { model: string; designJson: string | null; userId?: string }): Promise<ScaleJob> {
  const src = from.sourceFile ? await readScaleFile('jobs', from.id, from.sourceFile) : null
  if (!src) throw new ScaleInputError('Ảnh gốc của job này không còn')
  await readyTarget(from.targetId)
  const created = await prisma.scaleJob.create({ data: { targetId: from.targetId, targetName: from.targetName, model: data.model, designJson: data.designJson, parentJobId: from.id, createdBy: data.userId ?? null } })
  const sourceFile = await writeScaleFile('jobs', created.id, 'src', src.bytes, from.sourceFile!.split('.').pop()!)
  return prisma.scaleJob.update({ where: { id: created.id }, data: { sourceFile } })
}

export async function rerunScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> {
  const job = await cloneJob(await getJob(id), { model: deps.settings.imageModel, designJson: null, userId })
  kick(job.id, deps, opts)
  return job
}

export async function fallbackScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> {
  if (!deps.settings.allowFallback) throw new ScaleInputError('Chưa bật model dự phòng')
  const from = await getJob(id)
  if (from.status !== 'failed' || !from.designJson) throw new ScaleInputError('Job này chưa dùng được model dự phòng')
  const job = await cloneJob(from, { model: deps.settings.fallbackModel, designJson: from.designJson, userId })
  kick(job.id, deps, opts)
  return job
}

function fail(id: string, error: string): Promise<ScaleJob> {
  return prisma.scaleJob.update({ where: { id }, data: { status: 'failed', error, completedAt: new Date() } })
}

export async function runPipeline(jobId: string, deps: ScaleDeps): Promise<ScaleJob> {
  try {
    const job = await getJob(jobId)
    if (job.status !== 'describing') return job
    const target = await readyTarget(job.targetId)
    const src = job.sourceFile ? await readScaleFile('jobs', job.id, job.sourceFile) : null
    const blank = await readScaleFile('targets', target.id, target.blankFile!)
    if (!src || !blank) throw new ScaleInputError(!src ? 'Ảnh gốc của job này không còn' : NOT_READY)
    if (!job.designJson && !deps.vision) throw new ScaleInputError('Chưa có API key Kie cho bước đọc ảnh')
    if (!deps.image) throw new ScaleInputError('Chưa có API key Kie cho bước tạo ảnh')
    const srcDataUrl = toDataUrl(src.bytes, src.mime)

    let design: Design
    if (job.designJson) {
      design = DesignSchema.parse(JSON.parse(job.designJson))
    } else {
      try {
        design = await deps.vision!.describe({ model: deps.visionModel, system: designSystemPrompt(), text: designUserText(target), images: [srcDataUrl], schema: DesignSchema, schemaName: 'scale_design' })
      } catch (err) {
        throw new Error(explainKieError(err, 'CS', deps.visionModel))
      }
      await prisma.scaleJob.update({ where: { id: job.id }, data: { designJson: JSON.stringify(design) } })
    }

    const prompt = buildScalePrompt(target, design)
    let taskId: string
    try {
      const form = await imageForm(deps.image, job.model)
      const srcUrl = await deps.image.uploadBase64(srcDataUrl, `scale-${job.id}-src.${job.sourceFile!.split('.').pop()}`)
      const blankUrl = await deps.image.uploadBase64(toDataUrl(blank.bytes, blank.mime), `scale-${job.id}-blank.${target.blankFile!.split('.').pop()}`)
      taskId = await deps.image.createTask(job.model, imageInput(form, prompt, [srcUrl, blankUrl], deps.settings.resolution))
    } catch (err) {
      throw new Error(explainKieError(err, 'Creative', job.model))
    }
    return await prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'running', providerTaskId: taskId, prompt } })
  } catch (err: any) {
    return fail(jobId, String(err?.message ?? err)).catch(() => getJob(jobId))
  }
}

async function finish(job: ScaleJob, url: string, cost: string | null, fetchImpl: typeof fetch): Promise<ScaleJob> {
  let resultFile: string
  try {
    const file = await fetchImage(url, fetchImpl)
    resultFile = await writeScaleFile('jobs', job.id, 'out', file.bytes, file.ext)
  } catch (err: any) {
    return prisma.scaleJob.update({ where: { id: job.id }, data: { resultUrl: url, cost: cost ?? job.cost, error: `Tải ảnh kết quả lỗi, sẽ thử lại: ${err?.message ?? err}` } })
  }
  const now = new Date()
  return prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'done', resultFile, resultUrl: null, cost: cost ?? job.cost, error: null, durationMs: now.getTime() - job.createdAt.getTime(), completedAt: now } })
}

export async function refreshScaleJob(id: string, deps: ScaleDeps): Promise<ScaleJob> {
  const job = await getJob(id)
  const age = Date.now() - job.createdAt.getTime()
  if (job.status === 'describing') return age > DESCRIBE_GIVE_UP_MS ? fail(id, 'Bị gián đoạn, bấm Tạo lại') : job
  if (job.status !== 'running') return job
  if (job.resultUrl) return finish(job, job.resultUrl, job.cost, deps.fetchImpl)
  if (age > RUN_GIVE_UP_MS) return fail(id, `Quá 30 phút chưa có kết quả, dừng theo dõi${job.error ? ` (lỗi cuối: ${job.error})` : ''}`)
  if (!job.providerTaskId || !deps.image) return job

  let result: PollResult
  try { result = await deps.image.poll(job.providerTaskId) } catch (err: any) {
    return prisma.scaleJob.update({ where: { id }, data: { error: `Poll lỗi: ${err?.message ?? err}` } })
  }
  if (result.state === 'running') return job.error ? prisma.scaleJob.update({ where: { id }, data: { error: null } }) : job
  if (result.state === 'failed') return fail(id, result.error)
  return finish(job, result.urls[0], result.credits == null ? null : `${result.credits} credits`, deps.fetchImpl)
}

export async function listScaleJobs(take = 100): Promise<ScaleJob[]> {
  return prisma.scaleJob.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(Math.round(take) || 100, 1), 300) })
}

export async function deleteScaleJob(id: string, user: { id: string; role: string }): Promise<void> {
  const job = await getJob(id)
  if (user.role !== 'SUPERADMIN' && job.createdBy !== user.id) throw new ScaleInputError('Chỉ người tạo hoặc superadmin được xóa')
  await prisma.scaleJob.deleteMany({ where: { id } })
  await deleteScaleFolder('jobs', id)
}
