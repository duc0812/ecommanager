'use client'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { shrinkImage } from '@/components/creative/GenerateForm'
import { postJson, scaleFileUrl, type ScaleTargetView } from '@/components/scale/types'

const ACCEPT = 'image/png,image/jpeg,image/webp'
const POLL_MS = 3000

type RowProps = { target: ScaleTargetView; onChange: (t: ScaleTargetView) => void; onRemoved: (id: string) => void }

function TargetRow({ target, onChange, onRemoved }: RowProps) {
  const [form, setForm] = useState({ name: target.name, sku: target.sku, blankDescription: target.blankDescription, unprintedParts: target.unprintedParts })
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const blankInput = useRef<HTMLInputElement>(null)
  const sourceInput = useRef<HTMLInputElement>(null)
  const base = `/api/tools/scale/targets/${target.id}`

  useEffect(() => {
    if (target.candidateStatus !== 'running') return
    const timer = setInterval(async () => {
      try { onChange((await postJson(`${base}/candidate`, undefined, 'GET')).target) } catch {}
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [target.candidateStatus, base, onChange])

  async function run(label: string, action: () => Promise<any>, done?: string) {
    setBusy(label)
    setMessage(null)
    try {
      const json = await action()
      if (json?.target) onChange(json.target)
      if (done) setMessage(done)
      return json
    } catch (err: any) {
      setMessage(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function pick(e: ChangeEvent<HTMLInputElement>, path: string, label: string) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const dataUrl = await shrinkImage(file)
    await run(label, () => postJson(`${base}/${path}`, { dataUrl }))
  }

  async function suggest() {
    const json = await run('suggest', () => postJson(`${base}/suggest`), 'Đã gợi ý mô tả, kiểm tra rồi bấm Lưu.')
    if (json?.blankDescription) setForm(f => ({ ...f, blankDescription: json.blankDescription, unprintedParts: json.unprintedParts ?? '' }))
  }

  async function remove() {
    if (!confirm(`Xoá sản phẩm đích ${target.sku} và ảnh phôi của nó?`)) return
    setBusy('delete')
    try { await postJson(base, undefined, 'DELETE'); onRemoved(target.id) } catch (err: any) { setMessage(err.message); setBusy(null) }
  }

  const dirty = form.name !== target.name || form.sku !== target.sku || form.blankDescription !== target.blankDescription || form.unprintedParts !== target.unprintedParts
  const input = 'w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm'

  return (
    <div className="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-lg border-b border-outline-variant/20 p-lg last:border-b-0">
      <div className="w-full max-w-[160px]">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-outline-variant/20 bg-white">
          {target.blankFile
            ? <img src={scaleFileUrl('targets', target.id, target.blankFile, target.updatedAt)} alt={`Phôi ${target.sku}`} className="h-full w-full object-contain" />
            : <span className="p-sm text-center text-body-sm text-on-surface-variant">Chưa có ảnh phôi</span>}
        </div>
        <div className="mt-sm flex flex-col gap-xs text-label-md">
          <button type="button" disabled={!!busy} onClick={() => blankInput.current?.click()} className="text-left text-secondary hover:underline disabled:opacity-50">Up ảnh phôi có sẵn</button>
          <button type="button" disabled={!!busy || target.candidateStatus === 'running'} onClick={() => sourceInput.current?.click()} className="text-left text-secondary hover:underline disabled:opacity-50">Tạo phôi từ ảnh</button>
          <input ref={blankInput} type="file" accept={ACCEPT} hidden onChange={e => pick(e, 'blank', 'blank')} />
          <input ref={sourceInput} type="file" accept={ACCEPT} hidden onChange={e => pick(e, 'candidate', 'candidate')} />
        </div>
      </div>

      <div className="flex flex-col gap-sm">
        <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr_auto] items-center gap-sm">
          <input value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} placeholder="Mã Merchize" className={input} />
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Tên sản phẩm" className={input} />
          <label className="flex items-center gap-xs text-body-sm text-on-surface-variant">
            <input type="checkbox" checked={target.active} disabled={!!busy} onChange={e => run('active', () => postJson(base, { active: e.target.checked }, 'PATCH'))} />
            {target.ready ? 'Đang bật' : target.active ? 'Bật (thiếu dữ liệu)' : 'Tắt'}
          </label>
        </div>
        <textarea value={form.blankDescription} onChange={e => setForm({ ...form, blankDescription: e.target.value })} rows={3} placeholder="Mô tả phôi (tiếng Anh): bố cục trước/sau, khoá kéo, lót, túi, bo…" className={input} />
        <input value={form.unprintedParts} onChange={e => setForm({ ...form, unprintedParts: e.target.value })} placeholder='Phần không in, ví dụ "The ribbing, zipper and sherpa lining"' className={input} />
        <div className="flex flex-wrap items-center gap-md text-label-md">
          <button type="button" disabled={!!busy || !dirty} onClick={() => run('save', () => postJson(base, form, 'PATCH'), 'Đã lưu.')} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg disabled:opacity-50">Lưu</button>
          <button type="button" disabled={!!busy || !target.blankFile} onClick={suggest} className="text-secondary hover:underline disabled:opacity-50">{busy === 'suggest' ? 'Đang đọc ảnh phôi…' : 'Gợi ý mô tả'}</button>
          <button type="button" disabled={!!busy} onClick={remove} className="ml-auto text-on-surface-variant hover:text-error disabled:opacity-50">Xoá</button>
        </div>
        {message && <p className="text-body-sm text-on-surface-variant">{message}</p>}

        {target.candidateStatus && (
          <div className="mt-sm rounded-lg border border-outline-variant/20 bg-surface p-md">
            <p className="text-label-sm text-on-surface-variant">Ảnh phôi nháp</p>
            {target.candidateStatus === 'running' && <p className="mt-xs text-body-sm text-on-surface-variant">Đang tạo, thường mất 1–3 phút…</p>}
            {target.candidateStatus === 'failed' && <p className="mt-xs break-words text-body-sm text-error">{target.candidateError}</p>}
            {target.candidateStatus === 'ready' && target.candidateFile && (
              <img src={scaleFileUrl('targets', target.id, target.candidateFile, target.updatedAt)} alt="Phôi nháp" className="mt-xs w-60 rounded-lg border border-outline-variant/20 bg-white" />
            )}
            <div className="mt-sm flex gap-md text-label-md">
              {target.candidateStatus === 'ready' && <button type="button" disabled={!!busy} onClick={() => run('accept', () => postJson(`${base}/candidate`, undefined, 'PUT'))} className="text-secondary hover:underline disabled:opacity-50">Dùng làm phôi</button>}
              <button type="button" disabled={!!busy} onClick={() => run('discard', () => postJson(`${base}/candidate`, undefined, 'DELETE'))} className="text-on-surface-variant hover:text-error disabled:opacity-50">Bỏ</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type Props = { targets: ScaleTargetView[]; onChange: (t: ScaleTargetView) => void; onRemoved: (id: string) => void }

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

  const input = 'rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm'

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex flex-wrap items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">checkroom</span>
        <h3 className="text-headline-sm text-primary">Sản phẩm đích</h3>
        <span className="text-body-sm text-on-surface-variant">{targets.filter(t => t.ready).length}/{targets.length} đang bật</span>
      </div>
      <div className="flex flex-wrap items-center gap-sm border-b border-outline-variant/20 p-lg">
        <input value={draft.sku} onChange={e => setDraft({ ...draft, sku: e.target.value })} placeholder="Mã Merchize" className={`${input} w-40`} />
        <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Tên sản phẩm" className={`${input} min-w-[240px] flex-1`} />
        <button type="button" disabled={adding || !draft.sku.trim() || !draft.name.trim()} onClick={add} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Thêm</button>
        {error && <p className="w-full text-body-sm text-error">{error}</p>}
      </div>
      {targets.map(t => <TargetRow key={t.id} target={t} onChange={onChange} onRemoved={onRemoved} />)}
    </section>
  )
}
