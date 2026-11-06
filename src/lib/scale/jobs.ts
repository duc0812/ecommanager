import { prisma } from '@/lib/db'
import type { ScaleJob } from '@/generated/prisma/client'
import type { PollResult } from '@/lib/creative/kie'
import type { ModelForm } from '@/lib/creative/schema-map'
import { fetchImage } from '@/lib/creative/storage'
import { composeViews } from '@/lib/scale/compose'
import { SHEET_PROMPT, buildApplyPrompt, type ViewSide } from '@/lib/scale/prompt'
import { ScaleInputError, explainKieError, type ImageClient, type ScaleDeps } from '@/lib/scale/settings'
import { deleteScaleFolder, readScaleFile, toDataUrl, writeScaleFile } from '@/lib/scale/storage'
import { getTarget, imageForm, imageInput, isReady, parseImage, type TargetWithViews } from '@/lib/scale/targets'

const DESCRIBE_GIVE_UP_MS = 5 * 60 * 1000
const RUN_GIVE_UP_MS = 30 * 60 * 1000
const NOT_READY = 'Sản phẩm đích chưa sẵn sàng'
const NO_IMAGE_KEY = 'Chưa có API key Kie cho bước tạo ảnh'
const SHEET_LABEL = 'Tách họa tiết'
const RATE_LIMITED = 'Kie đang giới hạn tốc độ gọi (429), đợi một lát rồi bấm Tạo lại'

// Step 0 is the pattern sheet made from the source photo; every other step prints that sheet onto one blank of the target.
type Step = {
  kind: 'sheet' | 'view'
  label: string
  status: 'waiting' | 'running' | 'done' | 'failed'
  viewId?: string
  side?: ViewSide
  blankDescription?: string
  unprintedParts?: string
  taskId?: string
  resultUrl?: string
  file?: string
  credits?: number | null
  error?: string
}

function parseSteps(job: Pick<ScaleJob, 'viewsJson'>): Step[] {
  try { const v = JSON.parse(job.viewsJson || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function scaleJobView(j: ScaleJob) {
  const view: Partial<ScaleJob> = { ...j }
  delete view.prompt
  delete view.designJson
  delete view.viewsJson
  delete view.providerTaskId
  delete view.resultUrl
  const steps = parseSteps(j)
  return {
    ...(view as Omit<ScaleJob, 'prompt' | 'designJson' | 'viewsJson' | 'providerTaskId' | 'resultUrl'>),
    hasDesign: steps.length > 0,
    views: steps.map(s => ({ label: s.label, status: s.status })),
    canRetryViews: j.status === 'failed' && steps.some(s => s.status === 'failed'),
  }
}

function stepError(step: Pick<Step, 'label' | 'error'>): string {
  const raw = step.error ?? 'lỗi không rõ'
  const refused = /sensitive|flagged|moderation|unsafe|safety|policy/i.test(raw)
  return `${step.label}: ${refused ? `Kie từ chối nội dung của bước này (bộ lọc kiểm duyệt của model): ${raw}` : raw}`
}

// Kie answers 429 "call frequency is too high" when several calls start at once; wait and try again before giving up.
async function kieRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delay = Number(process.env.SCALE_RETRY_DELAY_MS ?? 5000)
  for (let attempt = 1; ; attempt++) {
    try { return await fn() } catch (err: any) {
      if (!/\b429\b|frequency is too high/i.test(String(err?.message ?? err))) throw err
      if (attempt >= 3) throw new Error(RATE_LIMITED)
      await new Promise(resolve => setTimeout(resolve, delay * attempt))
    }
  }
}

async function getJob(id: string): Promise<ScaleJob> {
  const job = await prisma.scaleJob.findUnique({ where: { id } })
  if (!job) throw new ScaleInputError('Không tìm thấy job')
  return job
}

async function readyTarget(id: string): Promise<TargetWithViews> {
  const target = await getTarget(id).catch(() => null)
  if (!target || !isReady(target)) throw new ScaleInputError(NOT_READY)
  return target
}

const current = (id: string) => prisma.scaleJob.findUnique({ where: { id } }).catch(() => null)
const ext = (name: string) => name.split('.').pop()!

function viewSteps(target: TargetWithViews): Step[] {
  return target.views.map(v => ({ kind: 'view' as const, label: v.label, status: 'waiting' as const, viewId: v.id, side: v.side as ViewSide, blankDescription: v.blankDescription, unprintedParts: v.unprintedParts }))
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

async function cloneJob(from: ScaleJob, data: { model: string; keepSheet: boolean; userId?: string }): Promise<ScaleJob> {
  const src = from.sourceFile ? await readScaleFile('jobs', from.id, from.sourceFile) : null
  if (!src) throw new ScaleInputError('Ảnh gốc của job này không còn')
  await readyTarget(from.targetId)
  const created = await prisma.scaleJob.create({ data: { targetId: from.targetId, targetName: from.targetName, model: data.model, parentJobId: from.id, createdBy: data.userId ?? null } })
  const sourceFile = await writeScaleFile('jobs', created.id, 'src', src.bytes, ext(from.sourceFile!))
  const sheet = data.keepSheet ? parseSteps(from).find(s => s.kind === 'sheet' && s.status === 'done' && s.file) : undefined
  const sheetFile = sheet ? await readScaleFile('jobs', from.id, sheet.file!) : null
  let viewsJson = '[]'
  if (sheet && sheetFile) {
    const file = await writeScaleFile('jobs', created.id, 'sheet', sheetFile.bytes, ext(sheet.file!))
    viewsJson = JSON.stringify([{ kind: 'sheet', label: SHEET_LABEL, status: 'done', file, credits: null }])
  }
  return prisma.scaleJob.update({ where: { id: created.id }, data: { sourceFile, viewsJson } })
}

export async function rerunScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> {
  const job = await cloneJob(await getJob(id), { model: deps.settings.imageModel, keepSheet: false, userId })
  kick(job.id, deps, opts)
  return job
}

export async function fallbackScaleJob(id: string, userId: string | undefined, deps: ScaleDeps, opts?: { run?: boolean }): Promise<ScaleJob> {
  if (!deps.settings.allowFallback) throw new ScaleInputError('Chưa bật model dự phòng')
  const from = await getJob(id)
  if (from.status !== 'failed') throw new ScaleInputError('Job này chưa dùng được model dự phòng')
  const job = await cloneJob(from, { model: deps.settings.fallbackModel, keepSheet: true, userId })
  kick(job.id, deps, opts)
  return job
}

function fail(id: string, error: string): Promise<ScaleJob> {
  return prisma.scaleJob.update({ where: { id }, data: { status: 'failed', error, completedAt: new Date() } })
}

const input = (form: ModelForm, prompt: string, urls: string[], deps: ScaleDeps, aspect: string) => imageInput(form, prompt, urls, deps.settings.resolution, aspect)

async function startSheet(job: ScaleJob, client: ImageClient, deps: ScaleDeps, suffix = ''): Promise<string> {
  const src = job.sourceFile ? await readScaleFile('jobs', job.id, job.sourceFile) : null
  if (!src) throw new ScaleInputError('Ảnh gốc của job này không còn')
  const form = await kieRetry(() => imageForm(client, job.model))
  const srcUrl = await kieRetry(() => client.uploadBase64(toDataUrl(src.bytes, src.mime), `scale-${job.id}-src${suffix}.${ext(job.sourceFile!)}`))
  if ((await current(job.id))?.status !== (suffix ? 'failed' : 'describing')) return ''
  return kieRetry(() => client.createTask(job.model, input(form, SHEET_PROMPT, [srcUrl], deps, deps.settings.sheetAspect)))
}

// A refresh, a delete or a re-run can close the job while this is still talking to Kie; every write is conditional on the job still being open.
export async function runPipeline(jobId: string, deps: ScaleDeps): Promise<ScaleJob | null> {
  try {
    const job = await getJob(jobId)
    if (job.status !== 'describing') return job
    const target = await readyTarget(job.targetId)
    if (!deps.image) throw new ScaleInputError(NO_IMAGE_KEY)
    const kept = parseSteps(job).find(s => s.kind === 'sheet' && s.status === 'done' && s.file)
    const sheet: Step = kept ?? { kind: 'sheet', label: SHEET_LABEL, status: 'running' }
    if (!kept) {
      try { sheet.taskId = await startSheet(job, deps.image, deps) } catch (err) {
        if (err instanceof ScaleInputError) throw err
        throw new Error(explainKieError(err, 'Creative', job.model))
      }
      if (!sheet.taskId) return current(jobId)
    }
    const steps = [sheet, ...viewSteps(target)]
    await prisma.scaleJob.updateMany({ where: { id: job.id, status: 'describing' }, data: { status: 'running', viewsJson: JSON.stringify(steps), prompt: SHEET_PROMPT } })
    return current(jobId)
  } catch (err: any) {
    await prisma.scaleJob.updateMany({ where: { id: jobId, status: 'describing' }, data: { status: 'failed', error: String(err?.message ?? err), completedAt: new Date() } }).catch(() => null)
    return current(jobId)
  }
}

async function collect(job: ScaleJob, step: Step, base: 'sheet' | `part-${number}`, deps: ScaleDeps): Promise<string | null> {
  if (!step.resultUrl) {
    if (!step.taskId || !deps.image) return null
    let result: PollResult
    try { result = await deps.image.poll(step.taskId) } catch (err: any) { return `Poll lỗi: ${err?.message ?? err}` }
    if (result.state === 'running') return null
    if (result.state === 'failed') { step.status = 'failed'; step.error = result.error; return null }
    step.resultUrl = result.urls[0]
    step.credits = result.credits
  }
  try {
    const file = await fetchImage(step.resultUrl, deps.fetchImpl)
    step.file = await writeScaleFile('jobs', job.id, base, file.bytes, file.ext)
    step.status = 'done'
    delete step.resultUrl
    return null
  } catch (err: any) {
    return `Tải ảnh kết quả lỗi, sẽ thử lại: ${err?.message ?? err}`
  }
}

async function startViews(job: ScaleJob, steps: Step[], deps: ScaleDeps): Promise<void> {
  const sheet = steps[0]
  const waiting = steps.map((s, i) => ({ s, i })).filter(x => x.s.kind === 'view' && x.s.status === 'waiting')
  if (!deps.image || sheet.status !== 'done' || !sheet.file || !waiting.length) return
  const client = deps.image
  const sheetFile = await readScaleFile('jobs', job.id, sheet.file)
  if (!sheetFile) throw new Error('missing pattern sheet')
  const stamp = Date.now()
  const form = await kieRetry(() => imageForm(client, job.model))
  const sheetUrl = await kieRetry(() => client.uploadBase64(toDataUrl(sheetFile.bytes, sheetFile.mime), `scale-${job.id}-sheet${waiting.some(x => x.s.error) ? `-r${stamp}` : ''}.${ext(sheet.file!)}`))
  const views = await prisma.scaleTargetView.findMany({ where: { id: { in: waiting.map(x => x.s.viewId!) } } })
  for (const { s, i } of waiting) {
    const view = views.find(v => v.id === s.viewId)
    const blank = view?.blankFile ? await readScaleFile('views', view.id, view.blankFile) : null
    if (!view || !blank) throw new ScaleInputError(`Góc "${s.label}" không còn ảnh phôi`)
    const retry = s.error ? `-r${stamp}` : ''
    const blankUrl = await kieRetry(() => client.uploadBase64(toDataUrl(blank.bytes, blank.mime), `scale-${job.id}-blank-${i - 1}${retry}.${ext(view.blankFile!)}`))
    const prompt = buildApplyPrompt(job.targetName, { side: s.side!, blankDescription: s.blankDescription ?? '', unprintedParts: s.unprintedParts ?? '' })
    const aspect = s.side === 'both' ? '1:1' : deps.settings.viewAspect
    s.taskId = await kieRetry(() => client.createTask(job.model, input(form, prompt, [sheetUrl, blankUrl], deps, aspect)))
    s.status = 'running'
    delete s.error
  }
}

async function advance(job: ScaleJob, deps: ScaleDeps): Promise<ScaleJob> {
  const steps = parseSteps(job)
  let note: string | null = null
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].status !== 'running') continue
    note = (await collect(job, steps[i], i === 0 ? 'sheet' : `part-${i - 1}`, deps)) ?? note
  }
  const failNow = (step: Step) => prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'failed', error: stepError(step), viewsJson: JSON.stringify(steps), completedAt: new Date() } })
  const failed = steps.find(s => s.status === 'failed')
  if (failed) return failNow(failed)

  try { await startViews(job, steps, deps) } catch (err) {
    const stuck = steps.find(s => s.kind === 'view' && s.status === 'waiting') ?? steps[0]
    stuck.status = 'failed'
    stuck.error = err instanceof ScaleInputError ? err.message : explainKieError(err, 'Creative', job.model)
    return failNow(stuck)
  }

  const parts = steps.filter(s => s.kind === 'view')
  if (parts.length && parts.every(s => s.status === 'done')) {
    const files = await Promise.all(parts.map(s => readScaleFile('jobs', job.id, s.file!)))
    const resultFile = await writeScaleFile('jobs', job.id, 'out', await composeViews(files.map(f => f!.bytes)), 'jpg')
    const credits = steps.reduce((sum, s) => sum + (s.credits ?? 0), 0)
    const now = new Date()
    return prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'done', resultFile, viewsJson: JSON.stringify(steps), cost: steps.some(s => s.credits != null) ? `${credits} credits` : null, error: null, durationMs: now.getTime() - job.createdAt.getTime(), completedAt: now } })
  }
  return prisma.scaleJob.update({ where: { id: job.id }, data: { viewsJson: JSON.stringify(steps), error: note } })
}

// Re-makes only the steps that failed; finished steps (already paid for) are kept.
export async function retryFailedViews(id: string, deps: ScaleDeps): Promise<ScaleJob> {
  const job = await getJob(id)
  const steps = parseSteps(job)
  if (job.status !== 'failed' || !steps.some(s => s.status === 'failed')) throw new ScaleInputError('Job này không có bước lỗi để tạo lại')
  if (!deps.image) throw new ScaleInputError(NO_IMAGE_KEY)
  await readyTarget(job.targetId)
  for (const step of steps) {
    if (step.status !== 'failed') continue
    delete step.taskId
    delete step.resultUrl
    delete step.file
    if (step.kind === 'view') { step.status = 'waiting'; continue }
    try { step.taskId = await startSheet(job, deps.image, deps, `-r${Date.now()}`) } catch (err) {
      if (err instanceof ScaleInputError) throw err
      throw new Error(explainKieError(err, 'Creative', job.model))
    }
    if (!step.taskId) throw new ScaleInputError('Job này đã thay đổi, tải lại trang')
    step.status = 'running'
    delete step.error
  }
  // createdAt restarts the 30-minute give-up clock for the re-made steps (the job also moves back to the top of the history).
  return prisma.scaleJob.update({ where: { id }, data: { status: 'running', error: null, completedAt: null, createdAt: new Date(), viewsJson: JSON.stringify(steps) } })
}

const locks = new Map<string, Promise<ScaleJob>>()

export async function refreshScaleJob(id: string, deps: ScaleDeps): Promise<ScaleJob> {
  const job = await getJob(id)
  const age = Date.now() - job.createdAt.getTime()
  if (job.status === 'describing') return age > DESCRIBE_GIVE_UP_MS ? fail(id, 'Bị gián đoạn, bấm Tạo lại') : job
  if (job.status !== 'running') return job
  if (age > RUN_GIVE_UP_MS) return fail(id, `Quá 30 phút chưa có kết quả, dừng theo dõi${job.error ? ` (lỗi cuối: ${job.error})` : ''}`)
  // Two open pages poll the same job; one advance at a time, so a step is never started twice.
  const running = locks.get(id)
  if (running) return running
  const work = advance(job, deps).finally(() => locks.delete(id))
  locks.set(id, work)
  return work
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
