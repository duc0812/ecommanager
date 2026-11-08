'use client'
import { useRef, useState, type ChangeEvent } from 'react'
import { shrinkImage } from '@/components/creative/GenerateForm'
import { postJson, scaleFileUrl, type ScaleTargetView, type ScaleViewRow } from '@/components/scale/types'

const ACCEPT = 'image/png,image/jpeg,image/webp'
const SIDE_LABEL = { both: 'Trước + sau (ảnh ghép)', front: 'Mặt trước', back: 'Mặt sau' }
const input = 'w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm'

type Change = (t: ScaleTargetView) => void

function useAction(onChange: Change) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  async function run(label: string, action: () => Promise<any>, done?: string) {
    setBusy(label)
    setMessage(null)
    try {
      const json = await action()
      if (json?.target) onChange(json.target)
      if (done) setMessage({ text: done, error: false })
      return json
    } catch (err: any) {
      setMessage({ text: err.message, error: true })
    } finally {
      setBusy(null)
    }
  }
  return { busy, message, run }
}

function ViewRow({ view, version, onChange }: { view: ScaleViewRow; version: string; onChange: Change }) {
  const [form, setForm] = useState({ label: view.label, side: view.side, blankDescription: view.blankDescription, unprintedParts: view.unprintedParts })
  const { busy, message, run } = useAction(onChange)
  const fileInput = useRef<HTMLInputElement>(null)
  const base = `/api/tools/scale/views/${view.id}`
  const dirty = form.label !== view.label || form.side !== view.side || form.blankDescription !== view.blankDescription || form.unprintedParts !== view.unprintedParts

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const dataUrl = await shrinkImage(file)
    await run('blank', () => postJson(`${base}/blank`, { dataUrl }))
  }

  async function suggest() {
    const json = await run('suggest', () => postJson(`${base}/suggest`), 'Đã gợi ý mô tả, kiểm tra rồi bấm Lưu.')
    if (json?.blankDescription) setForm(f => ({ ...f, blankDescription: json.blankDescription, unprintedParts: json.unprintedParts ?? '' }))
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-md rounded-lg border border-outline-variant/20 bg-surface p-md">
      <div className="w-full max-w-[120px]">
        <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-lg border border-outline-variant/20 bg-white">
          {view.blankFile
            ? <img src={scaleFileUrl('views', view.id, view.blankFile, version)} alt={`Phôi ${view.label}`} className="h-full w-full object-contain" />
            : <span className="p-xs text-center text-body-sm text-on-surface-variant">Chưa có ảnh phôi</span>}
        </div>
        <button type="button" disabled={!!busy} onClick={() => fileInput.current?.click()} className="mt-xs text-label-md text-secondary hover:underline disabled:opacity-50">Up ảnh phôi</button>
        <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={pick} />
      </div>
      <div className="flex flex-col gap-sm">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-sm">
          <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Tên góc" className={input} />
          <select value={form.side} onChange={e => setForm({ ...form, side: e.target.value as ScaleViewRow['side'] })} className={input}>
            <option value="both">{SIDE_LABEL.both}</option>
            <option value="both">{SIDE_LABEL.both}</option>
          <option value="front">{SIDE_LABEL.front}</option>
            <option value="back">{SIDE_LABEL.back}</option>
          </select>
        </div>
        <textarea value={form.blankDescription} onChange={e => setForm({ ...form, blankDescription: e.target.value })} rows={3} placeholder="Mô tả phôi của góc này (tiếng Anh)" className={input} />
        <input value={form.unprintedParts} onChange={e => setForm({ ...form, unprintedParts: e.target.value })} placeholder='Phần không in, ví dụ "The ribbing, zipper and sherpa lining"' className={input} />
        <div className="flex flex-wrap items-center gap-md text-label-md">
          <button type="button" disabled={!!busy || !dirty} onClick={() => run('save', () => postJson(base, form, 'PATCH'), 'Đã lưu.')} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg disabled:opacity-50">Lưu</button>
          <button type="button" disabled={!!busy || !view.blankFile} onClick={suggest} className="text-secondary hover:underline disabled:opacity-50">{busy === 'suggest' ? 'Đang đọc ảnh phôi…' : 'Gợi ý mô tả'}</button>
          <button type="button" disabled={!!busy} onClick={() => { if (confirm(`Xoá góc "${view.label}"?`)) run('delete', () => postJson(base, undefined, 'DELETE')) }} className="ml-auto text-on-surface-variant hover:text-error disabled:opacity-50">Xoá góc</button>
        </div>
        {message && <p className={`text-body-sm ${message.error ? 'text-error' : 'text-on-surface-variant'}`}>{message.text}</p>}
      </div>
    </div>
  )
}

function TargetRow({ target, onChange, onRemoved }: { target: ScaleTargetView; onChange: Change; onRemoved: (id: string) => void }) {
  const [form, setForm] = useState({ name: target.name, sku: target.sku })
  const [newView, setNewView] = useState<{ label: string; side: ScaleViewRow['side'] }>({ label: '', side: 'both' })
  const { busy, message, run } = useAction(onChange)
  const base = `/api/tools/scale/targets/${target.id}`
  const views = target.views ?? []
  const dirty = form.name !== target.name || form.sku !== target.sku

  async function remove() {
    if (!confirm(`Xoá sản phẩm đích ${target.sku} và mọi ảnh phôi của nó?`)) return
    const json = await run('delete', () => postJson(base, undefined, 'DELETE'))
    if (json?.ok) onRemoved(target.id)
  }

  async function addView() {
    const json = await run('view', () => postJson(`${base}/views`, newView))
    if (json?.target) setNewView({ label: '', side: 'both' })
  }

  return (
    <div className="flex flex-col gap-md border-b border-outline-variant/20 p-lg last:border-b-0">
      <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto_auto] items-center gap-sm">
        <input value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} placeholder="Mã Merchize" className={input} />
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Tên sản phẩm" className={input} />
        <label className="flex items-center gap-xs text-body-sm text-on-surface-variant">
          <input type="checkbox" checked={!!target.active} disabled={!!busy} onChange={e => run('active', () => postJson(base, { active: e.target.checked }, 'PATCH'))} />
          {target.ready ? 'Đang bật' : target.active ? 'Bật (thiếu dữ liệu)' : 'Tắt'}
        </label>
        <div className="flex items-center gap-md text-label-md">
          <button type="button" disabled={!!busy || !dirty} onClick={() => run('save', () => postJson(base, form, 'PATCH'), 'Đã lưu.')} className="text-secondary hover:underline disabled:opacity-50">Lưu tên</button>
          <button type="button" disabled={!!busy} onClick={remove} className="text-on-surface-variant hover:text-error disabled:opacity-50">Xoá</button>
        </div>
      </div>
      {message && <p className={`text-body-sm ${message.error ? 'text-error' : 'text-on-surface-variant'}`}>{message.text}</p>}
      {views.map(v => <ViewRow key={v.id} view={v} version={target.updatedAt} onChange={onChange} />)}
      <div className="flex flex-wrap items-center gap-sm">
        <input value={newView.label} onChange={e => setNewView({ ...newView, label: e.target.value })} placeholder="Tên ảnh phôi mới (ví dụ: Trước + sau)" className={`${input} max-w-[280px]`} />
        <select value={newView.side} onChange={e => setNewView({ ...newView, side: e.target.value as ScaleViewRow['side'] })} className={`${input} max-w-[160px]`}>
          <option value="both">{SIDE_LABEL.both}</option>
          <option value="front">{SIDE_LABEL.front}</option>
          <option value="back">{SIDE_LABEL.back}</option>
        </select>
        <button type="button" disabled={!!busy || !newView.label.trim()} onClick={addView} className="text-label-md text-secondary hover:underline disabled:opacity-50">Thêm góc</button>
        <p className="text-body-sm text-on-surface-variant">Thường mỗi sản phẩm chỉ cần một ảnh phôi ghép sẵn mặt trước và mặt sau. Có nhiều ảnh phôi thì mỗi ảnh được in riêng rồi ghép lại theo thứ tự.</p>
      </div>
    </div>
  )
}

type Props = { targets: ScaleTargetView[]; onChange: Change; onRemoved: (id: string) => void }

export function TargetManager({ targets, onChange, onRemoved }: Props) {
  const [draft, setDraft] = useState({ sku: '', name: '' })
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function add() {
    setAdding(true)
    setError(null)
    try {
      onChange((await postJson('/api/tools/scale/targets', draft)).target)
      setDraft({ sku: '', name: '' })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex flex-wrap items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">checkroom</span>
        <h3 className="text-headline-sm text-primary">Sản phẩm đích</h3>
        <span className="text-body-sm text-on-surface-variant">{targets.filter(t => t.ready).length}/{targets.length} đang bật</span>
      </div>
      <div className="flex flex-wrap items-center gap-sm border-b border-outline-variant/20 p-lg">
        <input value={draft.sku} onChange={e => setDraft({ ...draft, sku: e.target.value })} placeholder="Mã Merchize" className={`${input} max-w-[160px]`} />
        <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Tên sản phẩm" className={`${input} min-w-[240px] flex-1`} />
        <button type="button" disabled={adding || !draft.sku.trim() || !draft.name.trim()} onClick={add} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Thêm</button>
        {error && <p className="w-full text-body-sm text-error">{error}</p>}
      </div>
      {targets.map(t => <TargetRow key={`${t.id}-${t.updatedAt}`} target={t} onChange={onChange} onRemoved={onRemoved} />)}
    </section>
  )
}
