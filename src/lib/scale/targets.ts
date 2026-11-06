import { prisma } from '@/lib/db'
import type { ScaleTarget, ScaleTargetView } from '@/generated/prisma/client'
import { buildInput, formFromInputSchema, type ModelForm } from '@/lib/creative/schema-map'
import { MAX_REF_BYTES, REF_TYPES_LABEL, extForMime, parseDataUrl } from '@/lib/creative/storage'
import { BlankDescriptionSchema, VIEW_SIDES, blankDescriptionSystemPrompt, type BlankDescription, type ViewSide } from '@/lib/scale/prompt'
import { ScaleInputError, explainKieError, type ImageClient, type ScaleDeps } from '@/lib/scale/settings'
import { deleteScaleFolder, readScaleFile, toDataUrl, writeScaleFile } from '@/lib/scale/storage'

export type TargetWithViews = ScaleTarget & { views: ScaleTargetView[] }
export type TargetPatch = Partial<Pick<ScaleTarget, 'name' | 'sku' | 'active' | 'sortOrder'>>
export type ViewPatch = Partial<Pick<ScaleTargetView, 'label' | 'side' | 'blankDescription' | 'unprintedParts' | 'sortOrder'>>

const viewComplete = (v: Pick<ScaleTargetView, 'blankFile' | 'blankDescription'>) => !!v.blankFile && !!v.blankDescription.trim()

export function isReady(t: Pick<TargetWithViews, 'active' | 'views'>): boolean {
  return t.active && t.views.length > 0 && t.views.every(viewComplete)
}

export function targetView(t: TargetWithViews) {
  return { ...t, ready: isReady(t) }
}

export function staffTargetView(t: TargetWithViews) {
  return { id: t.id, name: t.name, sku: t.sku, thumbs: t.views.filter(v => v.blankFile).map(v => ({ viewId: v.id, file: v.blankFile! })), updatedAt: t.updatedAt, ready: isReady(t) }
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

export function imageInput(form: ModelForm, prompt: string, urls: string[], resolution: string, aspect: string): Record<string, unknown> {
  const options: Record<string, string> = {}
  for (const opt of form.options) {
    if (opt.name === 'resolution' && opt.values.includes(resolution)) options[opt.name] = resolution
    else if (opt.values.includes(aspect)) options[opt.name] = aspect
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

function attachViews(targets: ScaleTarget[], views: ScaleTargetView[]): TargetWithViews[] {
  return targets.map(t => ({ ...t, views: views.filter(v => v.targetId === t.id) }))
}

export async function getTarget(id: string): Promise<TargetWithViews> {
  const t = await prisma.scaleTarget.findUnique({ where: { id } })
  if (!t) throw new ScaleInputError('Không tìm thấy sản phẩm đích')
  const views = await prisma.scaleTargetView.findMany({ where: { targetId: id }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] })
  return { ...t, views }
}

export async function listTargets(opts: { readyOnly?: boolean } = {}): Promise<TargetWithViews[]> {
  const [targets, views] = await Promise.all([
    prisma.scaleTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.scaleTargetView.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
  ])
  const rows = attachViews(targets, views)
  return opts.readyOnly ? rows.filter(isReady) : rows
}

async function assertSkuFree(sku: string, exceptId?: string) {
  const clash = await prisma.scaleTarget.findUnique({ where: { sku } })
  if (clash && clash.id !== exceptId) throw new ScaleInputError(`Mã ${sku} đã có`)
}

export async function createTarget(p: { name: string; sku: string }): Promise<TargetWithViews> {
  const name = String(p.name ?? '').trim()
  const sku = String(p.sku ?? '').trim().toUpperCase()
  if (!name) throw new ScaleInputError('Chưa nhập tên sản phẩm')
  if (!sku) throw new ScaleInputError('Chưa nhập mã sản phẩm')
  await assertSkuFree(sku)
  const last = await prisma.scaleTarget.findFirst({ orderBy: { sortOrder: 'desc' } })
  const t = await prisma.scaleTarget.create({ data: { name, sku, sortOrder: (last?.sortOrder ?? 0) + 1 } })
  return { ...t, views: [] }
}

export async function updateTarget(id: string, p: TargetPatch): Promise<TargetWithViews> {
  const current = await getTarget(id)
  const data: TargetPatch = {}
  if (typeof p.name === 'string') { if (!p.name.trim()) throw new ScaleInputError('Chưa nhập tên sản phẩm'); data.name = p.name.trim() }
  if (typeof p.sku === 'string') {
    const sku = p.sku.trim().toUpperCase()
    if (!sku) throw new ScaleInputError('Chưa nhập mã sản phẩm')
    await assertSkuFree(sku, id)
    data.sku = sku
  }
  if (typeof p.sortOrder === 'number' && Number.isFinite(p.sortOrder)) data.sortOrder = Math.round(p.sortOrder)
  if (typeof p.active === 'boolean') data.active = p.active
  if (data.active && !isReady({ active: true, views: current.views })) throw new ScaleInputError('Cần ít nhất một góc có ảnh phôi và mô tả trước khi bật')
  const t = await prisma.scaleTarget.update({ where: { id }, data })
  return { ...t, views: current.views }
}

export async function deleteTarget(id: string): Promise<void> {
  const views = await prisma.scaleTargetView.findMany({ where: { targetId: id }, select: { id: true } })
  await prisma.scaleTargetView.deleteMany({ where: { targetId: id } })
  await prisma.scaleTarget.deleteMany({ where: { id } })
  await Promise.all(views.map(v => deleteScaleFolder('views', v.id)))
  await deleteScaleFolder('targets', id)
}

function parseSide(side: unknown): ViewSide {
  if (!VIEW_SIDES.includes(side as ViewSide)) throw new ScaleInputError('Mặt áo phải là front hoặc back')
  return side as ViewSide
}

async function getView(id: string): Promise<ScaleTargetView> {
  const v = await prisma.scaleTargetView.findUnique({ where: { id } })
  if (!v) throw new ScaleInputError('Không tìm thấy góc này')
  return v
}

const touchTarget = (id: string) => prisma.scaleTarget.updateMany({ where: { id }, data: { updatedAt: new Date() } })

export async function createView(targetId: string, p: { label: string; side: ViewSide }): Promise<ScaleTargetView> {
  await getTarget(targetId)
  const label = String(p.label ?? '').trim()
  if (!label) throw new ScaleInputError('Chưa nhập tên góc')
  const side = parseSide(p.side)
  const last = await prisma.scaleTargetView.findFirst({ where: { targetId }, orderBy: { sortOrder: 'desc' } })
  const view = await prisma.scaleTargetView.create({ data: { targetId, label, side, sortOrder: (last?.sortOrder ?? 0) + 1 } })
  await touchTarget(targetId)
  return view
}

export async function updateView(id: string, p: ViewPatch): Promise<ScaleTargetView> {
  const current = await getView(id)
  const data: ViewPatch = {}
  if (typeof p.label === 'string') { if (!p.label.trim()) throw new ScaleInputError('Chưa nhập tên góc'); data.label = p.label.trim() }
  if (p.side !== undefined) data.side = parseSide(p.side)
  if (typeof p.blankDescription === 'string') data.blankDescription = p.blankDescription.trim()
  if (typeof p.unprintedParts === 'string') data.unprintedParts = p.unprintedParts.trim()
  if (typeof p.sortOrder === 'number' && Number.isFinite(p.sortOrder)) data.sortOrder = Math.round(p.sortOrder)
  const view = await prisma.scaleTargetView.update({ where: { id }, data })
  await touchTarget(current.targetId)
  return view
}

export async function deleteView(id: string): Promise<void> {
  const view = await getView(id)
  await prisma.scaleTargetView.deleteMany({ where: { id } })
  await deleteScaleFolder('views', id)
  await touchTarget(view.targetId)
}

export async function setViewBlank(id: string, dataUrl: string): Promise<ScaleTargetView> {
  const current = await getView(id)
  const img = parseImage(dataUrl)
  const name = await writeScaleFile('views', id, 'blank', img.bytes, img.ext)
  const view = await prisma.scaleTargetView.update({ where: { id }, data: { blankFile: name } })
  await touchTarget(current.targetId)
  return view
}

export async function suggestViewDescription(id: string, deps: ScaleDeps): Promise<BlankDescription> {
  const view = await getView(id)
  const target = await getTarget(view.targetId)
  const blank = view.blankFile ? await readScaleFile('views', id, view.blankFile) : null
  if (!blank) throw new ScaleInputError('Chưa có ảnh phôi')
  if (!deps.vision) throw new ScaleInputError('Chưa có API key Kie cho bước đọc ảnh')
  try {
    return await deps.vision.describe({ model: deps.visionModel, system: blankDescriptionSystemPrompt(), text: `Blank mockup of: ${target.name}. This image shows the ${view.side.toUpperCase()} of the garment.`, images: [toDataUrl(blank.bytes, blank.mime)], schema: BlankDescriptionSchema, schemaName: 'scale_blank' })
  } catch (err) {
    throw new Error(explainKieError(err, 'CS', deps.visionModel))
  }
}
