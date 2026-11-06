import { prisma } from '@/lib/db'
import type { ScaleJob } from '@/generated/prisma/client'
import type { PollResult } from '@/lib/creative/kie'
import type { ModelForm } from '@/lib/creative/schema-map'
import { fetchImage } from '@/lib/creative/storage'
import { composeViews } from '@/lib/scale/compose'
import { DesignSchema, buildMatchPrompt, buildViewPrompt, designSystemPrompt, designUserText, type Design, type ViewSide } from '@/lib/scale/prompt'
import { ScaleInputError, explainKieError, type ScaleDeps } from '@/lib/scale/settings'
import { deleteScaleFolder, readScaleFile, toDataUrl, writeScaleFile } from '@/lib/scale/storage'
import { getTarget, imageForm, imageInput, isReady, parseImage, type TargetWithViews } from '@/lib/scale/targets'

const DESCRIBE_GIVE_UP_MS = 5 * 60 * 1000
const RUN_GIVE_UP_MS = 30 * 60 * 1000
const NOT_READY = 'Sản phẩm đích chưa sẵn sàng'

type ViewState = {
  viewId: string
  label: string
  side: ViewSide
  status: 'waiting' | 'running' | 'done' | 'failed'
  blankDescription: string
  unprintedParts: string
  blankUrl: string
  after?: number
  taskId?: string
  resultUrl?: string
  file?: string
  credits?: number | null
  error?: string
}

function parseViews(job: Pick<ScaleJob, 'viewsJson'>): ViewState[] {
  try { const v = JSON.parse(job.viewsJson || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function scaleJobView(j: ScaleJob) {
  const view: Partial<ScaleJob> = { ...j }
  delete view.prompt
  delete view.designJson
  delete view.viewsJson
  delete view.providerTaskId
  delete view.resultUrl
  const states = parseViews(j)
  return {
    ...(view as Omit<ScaleJob, 'prompt' | 'designJson' | 'viewsJson' | 'providerTaskId' | 'resultUrl'>),
    hasDesign: !!j.designJson,
    views: states.map(v => ({ label: v.label, status: v.status })),
    canRetryViews: j.status === 'failed' && !!j.designJson && states.some(v => v.status === 'failed'),
  }
}

function viewError(state: Pick<ViewState, 'label' | 'error'>): string {
  const raw = state.error ?? 'lỗi không rõ'
  const refused = /sensitive|flagged|moderation|unsafe|safety|policy/i.test(raw)
  return `${state.label}: ${refused ? `Kie từ chối nội dung của góc này (bộ lọc kiểm duyệt của model): ${raw}` : raw}`
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

const RATE_LIMITED = 'Kie đang giới hạn tốc độ gọi (429), đợi một lát rồi bấm Tạo lại'

// Kie answers 429 "call frequency is too high" when several views start at once; wait and try again before giving up.
async function kieRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delay = Number(process.env.SCALE_RETRY_DELAY_MS ?? 5000)
  for (let attempt = 1; ; attempt++) {
    try { return await fn() } catch (err: any) {
      if (!/429|frequency is too high/i.test(String(err?.message ?? err))) throw err
      if (attempt >= 3) throw new Error(RATE_LIMITED)
      await new Promise(resolve => setTimeout(resolve, delay * attempt))
    }
  }
}

const current = (id: string) => prisma.scaleJob.findUnique({ where: { id } }).catch(() => null)
const input = (form: ModelForm, prompt: string, urls: string[], deps: ScaleDeps) => imageInput(form, prompt, urls, deps.settings.resolution, deps.settings.viewAspect)

// A refresh, a delete or a re-run can close the job while this is still talking to Kie; every write is conditional on the job still being open.
export async function runPipeline(jobId: string, deps: ScaleDeps): Promise<ScaleJob | null> {
  try {
    const job = await getJob(jobId)
    if (job.status !== 'describing') return job
    const target = await readyTarget(job.targetId)
    const src = job.sourceFile ? await readScaleFile('jobs', job.id, job.sourceFile) : null
    if (!src) throw new ScaleInputError('Ảnh gốc của job này không còn')
    const blanks = await Promise.all(target.views.map(v => readScaleFile('views', v.id, v.blankFile!)))
    if (blanks.some(b => !b)) throw new ScaleInputError(NOT_READY)
    if (!job.designJson && !deps.vision) throw new ScaleInputError('Chưa có API key Kie cho bước đọc ảnh')
    if (!deps.image) throw new ScaleInputError('Chưa có API key Kie cho bước tạo ảnh')
    const srcDataUrl = toDataUrl(src.bytes, src.mime)

    let design: Design
    if (job.designJson) {
      design = DesignSchema.parse(JSON.parse(job.designJson))
    } else {
      try {
        design = await deps.vision!.describe({ model: deps.visionModel, system: designSystemPrompt(), text: designUserText(target.name), images: [srcDataUrl], schema: DesignSchema, schemaName: 'scale_design' })
      } catch (err) {
        throw new Error(explainKieError(err, 'CS', deps.visionModel))
      }
      const saved = await prisma.scaleJob.updateMany({ where: { id: job.id, status: 'describing' }, data: { designJson: JSON.stringify(design) } })
      if (!saved.count) return current(jobId)
    }

    const states: ViewState[] = []
    const prompts: string[] = []
    try {
      const form = await kieRetry(() => imageForm(deps.image!, job.model))
      const srcUrl = await kieRetry(() => deps.image!.uploadBase64(srcDataUrl, `scale-${job.id}-src.${job.sourceFile!.split('.').pop()}`))
      for (let i = 0; i < target.views.length; i++) {
        const v = target.views[i]
        const blankUrl = await kieRetry(() => deps.image!.uploadBase64(toDataUrl(blanks[i]!.bytes, blanks[i]!.mime), `scale-${job.id}-blank-${i}.${v.blankFile!.split('.').pop()}`))
        const first = states.findIndex(s => s.side === v.side)
        states.push({ viewId: v.id, label: v.label, side: v.side as ViewSide, status: first === -1 ? 'running' : 'waiting', blankDescription: v.blankDescription, unprintedParts: v.unprintedParts, blankUrl, ...(first === -1 ? {} : { after: first }) })
      }
      if ((await current(jobId))?.status !== 'describing') return current(jobId)
      for (const state of states) {
        if (state.status !== 'running') continue
        const prompt = buildViewPrompt(target.name, state, design)
        prompts.push(`[${state.label}]\n${prompt}`)
        state.taskId = await kieRetry(() => deps.image!.createTask(job.model, input(form, prompt, [srcUrl, state.blankUrl], deps)))
      }
    } catch (err) {
      throw new Error(explainKieError(err, 'Creative', job.model))
    }
    await prisma.scaleJob.updateMany({ where: { id: job.id, status: 'describing' }, data: { status: 'running', viewsJson: JSON.stringify(states), prompt: prompts.join('\n\n') } })
    return current(jobId)
  } catch (err: any) {
    await prisma.scaleJob.updateMany({ where: { id: jobId, status: 'describing' }, data: { status: 'failed', error: String(err?.message ?? err), completedAt: new Date() } }).catch(() => null)
    return current(jobId)
  }
}

async function savePart(job: ScaleJob, index: number, state: ViewState, deps: ScaleDeps): Promise<string | null> {
  try {
    const file = await fetchImage(state.resultUrl!, deps.fetchImpl)
    state.file = await writeScaleFile('jobs', job.id, `part-${index}`, file.bytes, file.ext)
    state.status = 'done'
    delete state.resultUrl
    return null
  } catch (err: any) {
    return `Tải ảnh kết quả lỗi, sẽ thử lại: ${err?.message ?? err}`
  }
}

async function advance(job: ScaleJob, deps: ScaleDeps): Promise<ScaleJob> {
  const states = parseViews(job)
  let note: string | null = null

  for (let i = 0; i < states.length; i++) {
    const state = states[i]
    if (state.status !== 'running') continue
    if (!state.resultUrl) {
      if (!state.taskId || !deps.image) continue
      let result: PollResult
      try { result = await deps.image.poll(state.taskId) } catch (err: any) { note = `Poll lỗi: ${err?.message ?? err}`; continue }
      if (result.state === 'running') continue
      if (result.state === 'failed') { state.status = 'failed'; state.error = result.error; continue }
      state.resultUrl = result.urls[0]
      state.credits = result.credits
    }
    note = (await savePart(job, i, state, deps)) ?? note
  }

  const failed = states.find(s => s.status === 'failed')
  if (failed) return prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'failed', error: viewError(failed), viewsJson: JSON.stringify(states), completedAt: new Date() } })

  if (deps.image) {
    for (let i = 0; i < states.length; i++) {
      const state = states[i]
      const lead = state.after === undefined ? null : states[state.after]
      if (state.status !== 'waiting' || !lead || lead.status !== 'done' || !lead.file) continue
      try {
        const part = await readScaleFile('jobs', job.id, lead.file)
        if (!part) throw new Error('missing finished view')
        const form = await kieRetry(() => imageForm(deps.image!, job.model))
        const partUrl = await kieRetry(() => deps.image!.uploadBase64(toDataUrl(part.bytes, part.mime), `scale-${job.id}-${lead.file}`))
        state.taskId = await kieRetry(() => deps.image!.createTask(job.model, input(form, buildMatchPrompt(job.targetName, state), [partUrl, state.blankUrl], deps)))
        state.status = 'running'
      } catch (err) {
        state.status = 'failed'
        state.error = explainKieError(err, 'Creative', job.model)
        return prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'failed', error: viewError(state), viewsJson: JSON.stringify(states), completedAt: new Date() } })
      }
    }
  }

  if (states.length && states.every(s => s.status === 'done')) {
    const parts = await Promise.all(states.map(s => readScaleFile('jobs', job.id, s.file!)))
    const composed = await composeViews(parts.map(p => p!.bytes))
    const resultFile = await writeScaleFile('jobs', job.id, 'out', composed, 'jpg')
    const credits = states.reduce((sum, s) => sum + (s.credits ?? 0), 0)
    const now = new Date()
    return prisma.scaleJob.update({ where: { id: job.id }, data: { status: 'done', resultFile, viewsJson: JSON.stringify(states), cost: states.some(s => s.credits != null) ? `${credits} credits` : null, error: null, durationMs: now.getTime() - job.createdAt.getTime(), completedAt: now } })
  }
  return prisma.scaleJob.update({ where: { id: job.id }, data: { viewsJson: JSON.stringify(states), error: note } })
}

// Re-makes only the views that failed; finished views (already paid for) are kept and still-running ones are collected on the next refresh.
export async function retryFailedViews(id: string, deps: ScaleDeps): Promise<ScaleJob> {
  const job = await getJob(id)
  const states = parseViews(job)
  if (job.status !== 'failed' || !job.designJson || !states.some(s => s.status === 'failed')) throw new ScaleInputError('Job này không có góc lỗi để tạo lại')
  if (!deps.image) throw new ScaleInputError('Chưa có API key Kie cho bước tạo ảnh')
  const src = job.sourceFile ? await readScaleFile('jobs', job.id, job.sourceFile) : null
  if (!src) throw new ScaleInputError('Ảnh gốc của job này không còn')
  const target = await readyTarget(job.targetId)
  const design = DesignSchema.parse(JSON.parse(job.designJson))
  const stamp = Date.now()
  try {
    const form = await kieRetry(() => imageForm(deps.image!, job.model))
    let srcUrl: string | null = null
    for (let i = 0; i < states.length; i++) {
      const state = states[i]
      if (state.status !== 'failed') continue
      const view = target.views.find(v => v.id === state.viewId)
      const blank = view?.blankFile ? await readScaleFile('views', view.id, view.blankFile) : null
      if (!view || !blank) throw new ScaleInputError(`Góc "${state.label}" không còn ảnh phôi`)
      state.blankUrl = await kieRetry(() => deps.image!.uploadBase64(toDataUrl(blank.bytes, blank.mime), `scale-${job.id}-blank-${i}-r${stamp}.${view.blankFile!.split('.').pop()}`))
      delete state.error
      delete state.taskId
      delete state.resultUrl
      delete state.file
      if (state.after !== undefined) { state.status = 'waiting'; continue }
      srcUrl ??= await kieRetry(() => deps.image!.uploadBase64(toDataUrl(src.bytes, src.mime), `scale-${job.id}-src-r${stamp}.${job.sourceFile!.split('.').pop()}`))
      state.taskId = await kieRetry(() => deps.image!.createTask(job.model, input(form, buildViewPrompt(job.targetName, state, design), [srcUrl!, state.blankUrl], deps)))
      state.status = 'running'
    }
  } catch (err) {
    if (err instanceof ScaleInputError) throw err
    throw new Error(explainKieError(err, 'Creative', job.model))
  }
  // createdAt restarts the 30-minute give-up clock for the re-made views (the job also moves back to the top of the history).
  return prisma.scaleJob.update({ where: { id }, data: { status: 'running', error: null, completedAt: null, createdAt: new Date(), viewsJson: JSON.stringify(states) } })
}

const locks = new Map<string, Promise<ScaleJob>>()

export async function refreshScaleJob(id: string, deps: ScaleDeps): Promise<ScaleJob> {
  const job = await getJob(id)
  const age = Date.now() - job.createdAt.getTime()
  if (job.status === 'describing') return age > DESCRIBE_GIVE_UP_MS ? fail(id, 'Bị gián đoạn, bấm Tạo lại') : job
  if (job.status !== 'running') return job
  if (age > RUN_GIVE_UP_MS) return fail(id, `Quá 30 phút chưa có kết quả, dừng theo dõi${job.error ? ` (lỗi cuối: ${job.error})` : ''}`)
  // Two open pages poll the same job; one advance at a time, so a waiting view is never started twice.
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
