'use client'
import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import { type CatalogModel, type Draft, type ModelForm, type Provider, type RefImage, PROVIDER_LABEL } from './types'

const MAX_IMAGES = 4
const MAX_BYTES = 10 * 1024 * 1024
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp']
const MAX_EDGE = 2048
const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// Phone photos are 3-12 MB; nginx and the JSON body cannot take four of them. Shrink to ≤2048 px JPEG unless the file is already small.
async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return readAsDataUrl(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && file.size <= SHRINK_ABOVE_BYTES) { bitmap.close(); return readAsDataUrl(file) }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const dataUrl = canvas.toDataURL(type, 0.88)
  if (type === 'image/png' && dataUrl.length > SHRINK_ABOVE_BYTES * 1.37) return canvas.toDataURL('image/jpeg', 0.88)
  return dataUrl
}

type Props = {
  draft: Draft
  onChange: (d: Draft) => void
  onSubmit: () => Promise<void>
  busy: boolean
  error: string | null
}

export function GenerateForm({ draft, onChange, onSubmit, busy, error }: Props) {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [configured, setConfigured] = useState(true)
  const [form, setForm] = useState<ModelForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pricing, setPricing] = useState<string | null>(null)
  const [customModel, setCustomModel] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function loadModels(provider: Provider, refresh = false) {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const res = await fetch(`/api/tools/creative/models?provider=${provider}${refresh ? '&refresh=1' : ''}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không tải được danh sách model')
      setModels(json.models ?? [])
      setConfigured(json.configured !== false)
    } catch (err: any) {
      setModels([])
      setModelsError(err.message)
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => { loadModels(draft.provider) }, [draft.provider])

  useEffect(() => {
    if (!draft.model) { setForm(null); setPricing(null); return }
    let cancelled = false
    setFormError(null)
    fetch(`/api/tools/creative/models?provider=${draft.provider}&model=${encodeURIComponent(draft.model)}`)
      .then(async res => {
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error || 'Không đọc được schema model')
        setForm(json.form)
        setPricing(json.pricing ?? null)
      })
      .catch(err => { if (!cancelled) { setForm(null); setFormError(err.message) } })
    return () => { cancelled = true }
  }, [draft.provider, draft.model])

  const china = models.filter(m => m.china)
  const others = models.filter(m => !m.china)
  const isCustom = draft.provider === 'replicate' && (customMode || (!!draft.model && !models.some(m => m.slug === draft.model)))

  function setProvider(provider: Provider) {
    onChange({ ...draft, provider, model: '', options: {} })
    setCustomModel('')
    setCustomMode(false)
  }

  function setModel(model: string) {
    onChange({ ...draft, model, options: {} })
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files)
    const next: RefImage[] = [...draft.images]
    for (const f of list) {
      if (next.length >= MAX_IMAGES) break
      if (!ACCEPT.includes(f.type) || f.size > MAX_BYTES) continue
      next.push({ dataUrl: await shrinkImage(f), name: f.name })
    }
    onChange({ ...draft, images: next })
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) addFiles(e.target.files)
    e.target.value = ''
  }

  const canSubmit = !busy && !!draft.model && !!draft.prompt.trim() && !!form && !(draft.images.length && !form.imageField)

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">auto_awesome</span>
        <h3 className="text-headline-sm text-primary">Tạo ảnh</h3>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-lg p-lg">
        <div className="flex flex-col gap-md">
          <div>
            <label className="text-label-sm text-on-surface-variant">Nhà cung cấp</label>
            <div className="mt-xs inline-flex rounded-lg border border-outline-variant/40 overflow-hidden">
              {(['kie', 'replicate'] as Provider[]).map(p => (
                <button key={p} type="button" onClick={() => setProvider(p)}
                  className={`px-lg py-sm text-label-md ${draft.provider === p ? 'bg-secondary text-on-secondary' : 'bg-surface text-on-surface hover:bg-surface-container'}`}>
                  {PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-label-sm text-on-surface-variant">Model {modelsLoading && '· đang tải…'}</label>
              {draft.provider === 'kie' && (
                <button type="button" onClick={() => loadModels('kie', true)} className="text-label-sm text-secondary hover:underline flex items-center gap-xs">
                  <span className="material-symbols-outlined text-[16px]">refresh</span>Làm mới catalog
                </button>
              )}
            </div>
            <select value={isCustom ? '__custom' : draft.model} onChange={e => { if (e.target.value === '__custom') { setCustomMode(true); setModel(customModel.trim()) } else { setCustomMode(false); setModel(e.target.value) } }}
              className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
              <option value="">— Chọn model —</option>
              {china.length > 0 && (
                <optgroup label="Model Trung Quốc">
                  {china.map(m => <option key={m.slug} value={m.slug}>{m.vendor} · {m.slug}{m.taskTypes.length ? ` (${m.taskTypes.join(', ')})` : ''}</option>)}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label="Khác">
                  {others.map(m => <option key={m.slug} value={m.slug}>{m.vendor} · {m.slug}{m.taskTypes.length ? ` (${m.taskTypes.join(', ')})` : ''}</option>)}
                </optgroup>
              )}
              {draft.provider === 'replicate' && <option value="__custom">Nhập slug khác (owner/name)…</option>}
            </select>
            {isCustom && (
              <input value={customModel} onChange={e => setCustomModel(e.target.value)} onBlur={() => setModel(customModel.trim())}
                onKeyDown={e => { if (e.key === 'Enter') setModel(customModel.trim()) }} placeholder="owner/name, ví dụ qwen/qwen-image — Enter để tải schema"
                className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm font-mono" />
            )}
            {!configured && <p className="mt-xs text-body-sm text-error">Chưa có API key {PROVIDER_LABEL[draft.provider]}. Dán key ở khung API keys bên dưới rồi làm mới.</p>}
            {modelsError && <p className="mt-xs text-body-sm text-error">{modelsError}</p>}
            {formError && <p className="mt-xs text-body-sm text-error">{formError}</p>}
          </div>

          <div>
            <label className="text-label-sm text-on-surface-variant">Prompt</label>
            <textarea value={draft.prompt} onChange={e => onChange({ ...draft, prompt: e.target.value })} rows={5} placeholder="Mô tả ảnh muốn tạo…"
              className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
          </div>

          {form && form.options.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-md">
              {form.options.map(opt => (
                <div key={opt.name}>
                  <label className="text-label-sm text-on-surface-variant">{opt.name}{opt.required ? ' *' : ''}</label>
                  <select value={draft.options[opt.name] ?? ''} onChange={e => onChange({ ...draft, options: { ...draft.options, [opt.name]: e.target.value } })}
                    className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
                    <option value="">{opt.required ? `Mặc định (${opt.default ?? opt.values[0]})` : '— bỏ qua —'}</option>
                    {opt.values.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-md flex-wrap">
            <button type="button" disabled={!canSubmit} onClick={onSubmit}
              className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50 flex items-center gap-xs">
              <span className="material-symbols-outlined text-[18px]">{busy ? 'hourglass_top' : 'brush'}</span>
              {busy ? 'Đang gửi…' : 'Tạo ảnh'}
            </button>
            {pricing && <span className="text-body-sm text-on-surface-variant">{pricing}</span>}
            {form && !form.imageField && draft.images.length > 0 && <span className="text-body-sm text-error">Model này không nhận ảnh tham chiếu.</span>}
            {form && form.imageField && !form.imageIsArray && draft.images.length > 1 && <span className="text-body-sm text-on-surface-variant">Model chỉ nhận 1 ảnh, sẽ dùng ảnh đầu tiên.</span>}
            {error && <span className="text-body-sm text-error">{error}</span>}
          </div>
        </div>

        <div>
          <label className="text-label-sm text-on-surface-variant">Ảnh tham chiếu ({draft.images.length}/{MAX_IMAGES})</label>
          <div onDragOver={e => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => fileInput.current?.click()}
            className={`mt-xs flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-md text-center ${dragOver ? 'border-secondary bg-secondary/5' : 'border-outline-variant/40 bg-surface'}`}>
            <span className="material-symbols-outlined text-[32px] text-on-surface-variant">add_photo_alternate</span>
            <p className="mt-xs text-body-sm text-on-surface-variant">Kéo thả hoặc bấm để chọn · PNG, JPG, WEBP ≤ 10 MB</p>
            <input ref={fileInput} type="file" accept={ACCEPT.join(',')} multiple hidden onChange={onPick} />
          </div>
          {draft.images.length > 0 && (
            <div className="mt-md grid grid-cols-2 gap-sm">
              {draft.images.map((img, i) => (
                <div key={i} className="relative group rounded-lg overflow-hidden border border-outline-variant/20">
                  <img src={img.dataUrl} alt={img.name} className="h-28 w-full object-cover" />
                  <button type="button" onClick={() => onChange({ ...draft, images: draft.images.filter((_, j) => j !== i) })}
                    className="absolute top-1 right-1 rounded-full bg-surface/90 p-0.5 opacity-0 group-hover:opacity-100">
                    <span className="material-symbols-outlined text-[18px] text-error">close</span>
                  </button>
                  <p className="truncate px-xs py-0.5 text-label-sm text-on-surface-variant">{img.name}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
