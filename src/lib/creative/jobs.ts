import { prisma } from '@/lib/db'
import type { CreativeJob } from '@/generated/prisma/client'
import { kieClient, type PollResult } from '@/lib/creative/kie'
import { replicateClient } from '@/lib/creative/replicate'
import { buildInput, formFromInputSchema, type ModelForm } from '@/lib/creative/schema-map'
import { MAX_REF_BYTES, MAX_REF_IMAGES, REF_TYPES_LABEL, deleteJobFolder, extForMime, parseDataUrl, saveRef, saveResult } from '@/lib/creative/storage'

export type Provider = 'kie' | 'replicate'
export type Providers = { kie?: ReturnType<typeof kieClient>; replicate?: ReturnType<typeof replicateClient> }

export class CreativeInputError extends Error {
  constructor(message: string) { super(message); this.name = 'CreativeInputError' }
}

const SLUG = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/
const GIVE_UP_MS = 30 * 60 * 1000

export function isValidModelSlug(model: string): boolean {
  return SLUG.test(model) && !model.split('/').some(seg => seg === '.' || seg === '..')
}

export type CreateJobInput = {
  provider: Provider
  model: string
  prompt: string
  images: { dataUrl: string; name: string }[]
  options: Record<string, string>
  userId?: string
}

function parseList(value: string | null | undefined): string[] {
  try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

export function jobView(j: CreativeJob) {
  let input: any = {}
  try { input = JSON.parse(j.inputJson || '{}') } catch { input = {} }
  return { ...j, refImages: parseList(j.refImages), resultFiles: parseList(j.resultFiles), resultUrls: parseList(j.resultUrls), input }
}

function validate(p: CreateJobInput): { mime: string; bytes: Buffer }[] {
  if (p.provider !== 'kie' && p.provider !== 'replicate') throw new CreativeInputError('Provider không hợp lệ')
  if (!p.model?.trim()) throw new CreativeInputError('Chưa chọn model')
  if (!isValidModelSlug(p.model.trim())) throw new CreativeInputError('Model không hợp lệ (dạng owner/name)')
  if (!p.prompt?.trim()) throw new CreativeInputError('Prompt không được để trống')
  if (p.images.length > MAX_REF_IMAGES) throw new CreativeInputError(`Chỉ nhận tối đa ${MAX_REF_IMAGES} ảnh tham chiếu`)
  const parsedImages: { mime: string; bytes: Buffer }[] = []
  for (const img of p.images) {
    const parsed = parseDataUrl(img.dataUrl)
    if (!parsed || !extForMime(parsed.mime)) throw new CreativeInputError(`Ảnh tham chiếu chỉ nhận ${REF_TYPES_LABEL}`)
    if (parsed.bytes.length > MAX_REF_BYTES) throw new CreativeInputError(`Ảnh ${img.name} vượt quá ${Math.round(MAX_REF_BYTES / 1024 / 1024)} MB`)
    parsedImages.push(parsed)
  }
  return parsedImages
}

export async function modelForm(provider: Provider, model: string, providers: Providers): Promise<ModelForm> {
  if (!isValidModelSlug(model)) throw new CreativeInputError('Model không hợp lệ (dạng owner/name)')
  const client = providers[provider]
  if (!client) throw new CreativeInputError(`Chưa có API key ${provider}`)
  let schema: { input: any; root: any } | null
  try { schema = await client.schema(model) } catch (err: any) { throw new CreativeInputError(`Không đọc được schema model ${model}: ${err?.message ?? err}`) }
  if (!schema) throw new CreativeInputError(`Model ${model} chưa có schema trên ${provider}`)
  return formFromInputSchema(schema.input, schema.root)
}

export async function createJob(p: CreateJobInput, providers: Providers): Promise<CreativeJob> {
  const parsedImages = validate(p)
  const client = providers[p.provider]
  if (!client) throw new CreativeInputError(`Chưa có API key ${p.provider}`)
  const form = await modelForm(p.provider, p.model, providers)
  if (p.images.length && !form.imageField) throw new CreativeInputError('Model này không nhận ảnh tham chiếu')

  const job = await prisma.creativeJob.create({ data: { provider: p.provider, model: p.model.trim(), prompt: p.prompt.trim(), createdBy: p.userId ?? null } })
  try {
    const refNames: string[] = []
    const urls: string[] = []
    for (let i = 0; i < p.images.length; i++) {
      const saved = await saveRef(job.id, i, parsedImages[i])
      refNames.push(saved.name)
      urls.push(p.provider === 'kie'
        ? await (client as ReturnType<typeof kieClient>).uploadBase64(p.images[i].dataUrl, saved.name)
        : await (client as ReturnType<typeof replicateClient>).uploadFile(saved.bytes, saved.name, saved.mime))
    }
    const input = buildInput(form, { prompt: p.prompt.trim(), imageUrls: urls, options: p.options ?? {} })
    const taskId = p.provider === 'kie'
      ? await (client as ReturnType<typeof kieClient>).createTask(p.model.trim(), input)
      : await (client as ReturnType<typeof replicateClient>).createPrediction(p.model.trim(), input)
    return await prisma.creativeJob.update({ where: { id: job.id }, data: { status: 'running', providerTaskId: taskId, inputJson: JSON.stringify(input), refImages: JSON.stringify(refNames) } })
  } catch (err: any) {
    await prisma.creativeJob.update({ where: { id: job.id }, data: { status: 'failed', error: String(err?.message ?? err), completedAt: new Date() } })
    throw err
  }
}

function costText(provider: Provider, r: Extract<PollResult, { state: 'done' }>): string | null {
  if (provider === 'kie') return r.credits == null ? null : `${r.credits} credits`
  return r.costTime == null ? null : `${r.costTime.toFixed(1)}s GPU`
}

async function finish(job: CreativeJob, urls: string[], cost: string | null, fetchImpl: typeof fetch): Promise<CreativeJob> {
  const names: string[] = []
  try {
    for (let i = 0; i < urls.length; i++) names.push(await saveResult(job.id, i, urls[i], fetchImpl))
  } catch (err: any) {
    return prisma.creativeJob.update({ where: { id: job.id }, data: { resultUrls: JSON.stringify(urls), cost: cost ?? job.cost, error: `Tải ảnh kết quả lỗi, sẽ thử lại: ${err?.message ?? err}` } })
  }
  const now = new Date()
  return prisma.creativeJob.update({ where: { id: job.id }, data: { status: 'done', resultFiles: JSON.stringify(names), resultUrls: JSON.stringify(urls), cost: cost ?? job.cost, error: null, durationMs: now.getTime() - job.createdAt.getTime(), completedAt: now } })
}

export async function refreshJob(id: string, providers: Providers, fetchImpl: typeof fetch = fetch): Promise<CreativeJob> {
  const job = await prisma.creativeJob.findUnique({ where: { id } })
  if (!job) throw new CreativeInputError('Không tìm thấy job')
  if (job.status !== 'queued' && job.status !== 'running') return job

  const pendingUrls = parseList(job.resultUrls)
  if (pendingUrls.length) return finish(job, pendingUrls, job.cost, fetchImpl)

  if (Date.now() - job.createdAt.getTime() > GIVE_UP_MS) {
    return prisma.creativeJob.update({ where: { id }, data: { status: 'failed', error: `Quá 30 phút chưa có kết quả, dừng theo dõi${job.error ? ` (lỗi cuối: ${job.error})` : ''}`, completedAt: new Date() } })
  }
  if (!job.providerTaskId) return job
  const provider = job.provider as Provider
  const client = providers[provider]
  if (!client) return job

  let result: PollResult
  try { result = await client.poll(job.providerTaskId) } catch (err: any) {
    return prisma.creativeJob.update({ where: { id }, data: { error: `Poll lỗi: ${err?.message ?? err}` } })
  }
  if (result.state === 'running') return job.error ? prisma.creativeJob.update({ where: { id }, data: { error: null } }) : job
  if (result.state === 'failed') return prisma.creativeJob.update({ where: { id }, data: { status: 'failed', error: result.error, completedAt: new Date() } })
  return finish(job, result.urls, costText(provider, result), fetchImpl)
}

export async function listJobs(f: { provider?: string; model?: string; status?: string; take?: number }): Promise<CreativeJob[]> {
  return prisma.creativeJob.findMany({
    where: { ...(f.provider ? { provider: f.provider } : {}), ...(f.model ? { model: f.model } : {}), ...(f.status ? { status: f.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(f.take ?? 100, 1), 500),
  })
}

export async function deleteJob(id: string): Promise<void> {
  await prisma.creativeJob.deleteMany({ where: { id } })
  await deleteJobFolder(id)
}
