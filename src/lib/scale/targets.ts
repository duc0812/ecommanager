import { prisma } from '@/lib/db'
import type { ScaleTarget } from '@/generated/prisma/client'
import { buildInput, formFromInputSchema, type ModelForm } from '@/lib/creative/schema-map'
import { MAX_REF_BYTES, REF_TYPES_LABEL, extForMime, fetchImage, parseDataUrl } from '@/lib/creative/storage'
import { BlankDescriptionSchema, MAKE_BLANK_PROMPT, blankDescriptionSystemPrompt, type BlankDescription } from '@/lib/scale/prompt'
import { ScaleInputError, explainKieError, type ImageClient, type ScaleDeps } from '@/lib/scale/settings'
import { deleteScaleFolder, readScaleFile, removeScaleFile, toDataUrl, writeScaleFile } from '@/lib/scale/storage'

export type TargetPatch = Partial<Pick<ScaleTarget, 'name' | 'sku' | 'blankDescription' | 'unprintedParts' | 'active' | 'sortOrder'>>

export function isReady(t: Pick<ScaleTarget, 'active' | 'blankFile' | 'blankDescription'>): boolean {
  return t.active && !!t.blankFile && !!t.blankDescription.trim()
}

export function targetView(t: ScaleTarget) {
  return { ...t, ready: isReady(t) }
}

export function parseImage(dataUrl: string): { mime: string; bytes: Buffer; ext: string } {
  const parsed = parseDataUrl(dataUrl)
  const ext = parsed ? extForMime(parsed.mime) : null
  if (!parsed || !ext) throw new ScaleInputError(`Ảnh chỉ nhận ${REF_TYPES_LABEL}`)
  if (parsed.bytes.length > MAX_REF_BYTES) throw new ScaleInputError(`Ảnh vượt quá ${Math.round(MAX_REF_BYTES / 1024 / 1024)} MB`)
  return { ...parsed, ext }
}

export function requireImageClient(deps: ScaleDeps): ImageClient {
  if (!deps.image) throw new ScaleInputError('Chưa có API key Kie cho bước tạo ảnh')
  return deps.image
}

export function imageInput(form: ModelForm, prompt: string, urls: string[], resolution: string): Record<string, unknown> {
  const options: Record<string, string> = {}
  for (const opt of form.options) {
    if (opt.name === 'resolution' && opt.values.includes(resolution)) options[opt.name] = resolution
    else if (opt.values.includes('1:1')) options[opt.name] = '1:1'
  }
  return buildInput(form, { prompt, imageUrls: urls, options })
}

export async function imageForm(client: ImageClient, model: string): Promise<ModelForm> {
  const schema = await client.schema(model)
  if (!schema) throw new Error(`Model ${model} chưa có schema trên Kie`)
  const form = formFromInputSchema(schema.input, schema.root)
  if (!form.imageField) throw new Error(`Model ${model} không nhận ảnh tham chiếu`)
  return form
}

async function getTarget(id: string): Promise<ScaleTarget> {
  const t = await prisma.scaleTarget.findUnique({ where: { id } })
  if (!t) throw new ScaleInputError('Không tìm thấy sản phẩm đích')
  return t
}

export async function listTargets(opts: { readyOnly?: boolean } = {}): Promise<ScaleTarget[]> {
  const rows = await prisma.scaleTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  return opts.readyOnly ? rows.filter(isReady) : rows
}

async function assertSkuFree(sku: string, exceptId?: string) {
  const clash = await prisma.scaleTarget.findUnique({ where: { sku } })
  if (clash && clash.id !== exceptId) throw new ScaleInputError(`Mã ${sku} đã có`)
}

export async function createTarget(p: { name: string; sku: string }): Promise<ScaleTarget> {
  const name = String(p.name ?? '').trim()
  const sku = String(p.sku ?? '').trim().toUpperCase()
  if (!name) throw new ScaleInputError('Chưa nhập tên sản phẩm')
  if (!sku) throw new ScaleInputError('Chưa nhập mã sản phẩm')
  await assertSkuFree(sku)
  const last = await prisma.scaleTarget.findFirst({ orderBy: { sortOrder: 'desc' } })
  return prisma.scaleTarget.create({ data: { name, sku, sortOrder: (last?.sortOrder ?? 0) + 1 } })
}

export async function updateTarget(id: string, p: TargetPatch): Promise<ScaleTarget> {
  const current = await getTarget(id)
  const data: TargetPatch = {}
  if (typeof p.name === 'string') { if (!p.name.trim()) throw new ScaleInputError('Chưa nhập tên sản phẩm'); data.name = p.name.trim() }
  if (typeof p.sku === 'string') {
    const sku = p.sku.trim().toUpperCase()
    if (!sku) throw new ScaleInputError('Chưa nhập mã sản phẩm')
    await assertSkuFree(sku, id)
    data.sku = sku
  }
  if (typeof p.blankDescription === 'string') data.blankDescription = p.blankDescription.trim()
  if (typeof p.unprintedParts === 'string') data.unprintedParts = p.unprintedParts.trim()
  if (typeof p.sortOrder === 'number' && Number.isFinite(p.sortOrder)) data.sortOrder = Math.round(p.sortOrder)
  if (typeof p.active === 'boolean') data.active = p.active
  const next = { ...current, ...data }
  if (next.active && !isReady(next)) throw new ScaleInputError('Cần có ảnh phôi và mô tả phôi trước khi bật')
  return prisma.scaleTarget.update({ where: { id }, data })
}

export async function deleteTarget(id: string): Promise<void> {
  await prisma.scaleTarget.deleteMany({ where: { id } })
  await deleteScaleFolder('targets', id)
}

export async function setBlank(id: string, dataUrl: string): Promise<ScaleTarget> {
  await getTarget(id)
  const img = parseImage(dataUrl)
  const name = await writeScaleFile('targets', id, 'blank', img.bytes, img.ext)
  return prisma.scaleTarget.update({ where: { id }, data: { blankFile: name } })
}

export async function startCandidate(id: string, dataUrl: string, deps: ScaleDeps): Promise<ScaleTarget> {
  await getTarget(id)
  const img = parseImage(dataUrl)
  const client = requireImageClient(deps)
  const model = deps.settings.imageModel
  let taskId: string
  try {
    const form = await imageForm(client, model)
    const url = await client.uploadBase64(dataUrl, `scale-blank-${id}-${Date.now()}.${img.ext}`)
    taskId = await client.createTask(model, imageInput(form, MAKE_BLANK_PROMPT, [url], deps.settings.resolution))
  } catch (err) {
    throw new Error(explainKieError(err, 'Creative', model))
  }
  await removeScaleFile('targets', id, 'candidate')
  return prisma.scaleTarget.update({ where: { id }, data: { candidateTaskId: taskId, candidateStatus: 'running', candidateFile: null, candidateError: null } })
}

export async function refreshCandidate(id: string, deps: ScaleDeps): Promise<ScaleTarget> {
  const t = await getTarget(id)
  if (t.candidateStatus !== 'running' || !t.candidateTaskId || !deps.image) return t
  let result
  try { result = await deps.image.poll(t.candidateTaskId) } catch (err: any) {
    return prisma.scaleTarget.update({ where: { id }, data: { candidateError: `Poll lỗi: ${err?.message ?? err}` } })
  }
  if (result.state === 'running') return t
  if (result.state === 'failed') return prisma.scaleTarget.update({ where: { id }, data: { candidateStatus: 'failed', candidateError: result.error } })
  try {
    const file = await fetchImage(result.urls[0], deps.fetchImpl)
    const name = await writeScaleFile('targets', id, 'candidate', file.bytes, file.ext)
    return prisma.scaleTarget.update({ where: { id }, data: { candidateStatus: 'ready', candidateFile: name, candidateError: null } })
  } catch (err: any) {
    return prisma.scaleTarget.update({ where: { id }, data: { candidateError: `Tải ảnh phôi lỗi, sẽ thử lại: ${err?.message ?? err}` } })
  }
}

export async function acceptCandidate(id: string): Promise<ScaleTarget> {
  const t = await getTarget(id)
  const file = t.candidateStatus === 'ready' && t.candidateFile ? await readScaleFile('targets', id, t.candidateFile) : null
  if (!file) throw new ScaleInputError('Chưa có ảnh phôi nháp để dùng')
  const name = await writeScaleFile('targets', id, 'blank', file.bytes, t.candidateFile!.split('.').pop()!)
  await removeScaleFile('targets', id, 'candidate')
  return prisma.scaleTarget.update({ where: { id }, data: { blankFile: name, candidateFile: null, candidateStatus: null, candidateTaskId: null, candidateError: null } })
}

export async function discardCandidate(id: string): Promise<ScaleTarget> {
  await getTarget(id)
  await removeScaleFile('targets', id, 'candidate')
  return prisma.scaleTarget.update({ where: { id }, data: { candidateFile: null, candidateStatus: null, candidateTaskId: null, candidateError: null } })
}

export async function suggestDescription(id: string, deps: ScaleDeps): Promise<BlankDescription> {
  const t = await getTarget(id)
  const blank = t.blankFile ? await readScaleFile('targets', id, t.blankFile) : null
  if (!blank) throw new ScaleInputError('Chưa có ảnh phôi')
  if (!deps.vision) throw new ScaleInputError('Chưa có API key Kie cho bước đọc ảnh')
  try {
    return await deps.vision.describe({ model: deps.visionModel, system: blankDescriptionSystemPrompt(), text: `Blank mockup of: ${t.name}.`, images: [toDataUrl(blank.bytes, blank.mime)], schema: BlankDescriptionSchema, schemaName: 'scale_blank' })
  } catch (err) {
    throw new Error(explainKieError(err, 'CS', deps.visionModel))
  }
}
