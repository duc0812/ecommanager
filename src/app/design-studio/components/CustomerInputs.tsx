'use client'
import { useState, type FormEvent } from 'react'
import type { TaskDetail } from './types'
import { copyText, layerForField, patchJson, taskUrl } from './model'
import { useToast } from './overlay'
import { ErrorBanner, Icon, btnText, card, iconBtn, input } from './ui'

function hasNonAscii(s: string) { return /[^\x00-\x7F]/.test(s) }

function layerLabel(field: string, detail: TaskDetail): { text: string; missing: boolean; title?: string } {
  const src = layerForField(field, detail.library, detail.profile?.layerMap)
  switch (src.source) {
    case 'none': return { text: '', missing: false }
    case 'guess': return { text: src.layer, missing: false, title: 'Đoán theo tên trường — sản phẩm chưa có PSD' }
    case 'library-missing': return { text: src.layer, missing: true, title: 'PSD của sản phẩm không có layer cho trường này' }
    case 'library':
    case 'profile':
      return { text: `${src.layer}${src.maxChars ? ` ≤${src.maxChars}` : ''}`, missing: false, title: `${src.source === 'library' ? 'Theo PSD của sản phẩm' : 'Theo bảng layer cũ của hồ sơ'} · ${src.fit}` }
  }
}

function CsNote({ detail, lastAsk, onChanged }: { detail: TaskDetail; lastAsk: string | null; onChanged: () => void }) {
  const { line, task, me } = detail
  const canEdit = me.isLeader || me.canEditNote === true
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(line.designNote ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const addOns = detail.order.addOns ?? []
  const empty = !line.designNote && !lastAsk && addOns.length === 0

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    const r = await patchJson(taskUrl(task.taskKey), { designNote: draft.trim() || null })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setEditing(false)
    onChanged()
  }

  return (
    <aside aria-label="Ghi chú CS" className={`flex-[1_1_280px] min-w-0 flex flex-col gap-xs rounded-lg px-[14px] py-sm border ${empty && !editing ? 'bg-surface-container-low border-outline-variant/40' : 'bg-amber-50 border-amber-200'}`}>
      <div className="flex items-center gap-xs">
        <Icon name="sticky_note_2" className="text-[18px] text-amber-800" />
        <span className="text-body-sm font-semibold text-amber-950">Ghi chú CS</span>
        {canEdit && !editing && (
          <button type="button" onClick={() => { setDraft(line.designNote ?? ''); setEditing(true) }} aria-label="Sửa ghi chú CS" title="Sửa ghi chú CS" className={`${iconBtn} ml-auto w-7 h-7`}>
            <Icon name="edit" className="text-[16px]" />
          </button>
        )}
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-xs">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={2000} autoFocus aria-label="Ghi chú CS"
            placeholder="Ghi chú của CS cho designer (để trống = xoá ghi chú)" className={`${input} w-full`} />
          <span className="flex items-center gap-xs">
            <button type="submit" className={btnText} disabled={busy}><Icon name="save" className="text-[16px]" />{busy ? 'Đang lưu…' : 'Lưu'}</button>
            <button type="button" className={btnText} disabled={busy} onClick={() => { setEditing(false); setDraft(line.designNote ?? ''); setError('') }}>Huỷ</button>
          </span>
          <ErrorBanner msg={error} onClose={() => setError('')} />
        </form>
      ) : (
        <>
          {line.designNote && <span className="text-body-sm text-on-surface whitespace-pre-wrap">{line.designNote}</span>}
          {lastAsk && <span className="text-body-sm text-amber-900">Đang hỏi khách: {lastAsk}</span>}
          {empty && <span className="text-body-sm text-on-surface-variant">Không có ghi chú</span>}
        </>
      )}
      {addOns.length > 0 && (
        <ul className="flex flex-col gap-[2px] text-label-sm text-on-surface">
          {addOns.map((a, i) => (
            <li key={`${a.title}-${i}`} className="flex items-start gap-xs break-words">
              <Icon name="add_circle" className="text-[14px] text-amber-800 mt-[1px]" />
              <span><b>{a.title}</b>{a.variantTitle ? ` [${a.variantTitle}]` : ''} ×{a.qty}{a.details ? ` — ${a.details}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

export default function CustomerInputs({ detail, refreshing, onRefresh, onChanged }: { detail: TaskDetail; refreshing: boolean; onRefresh: () => void; onChanged: () => void }) {
  const { line, task } = detail
  const toast = useToast()
  const lastAsk = task.status === 'ASK_CUSTOMER' ? [...detail.events].reverse().find(e => e.type === 'ASK')?.message.replace(/^Hỏi khách:\s*/, '') ?? null : null
  const fields = line.personalization
  const count = !line.attributesLoaded ? 'chưa nạp' : fields.length ? `${fields.length} trường` : line.customized ? 'khách không nhập gì' : 'non-custom'

  return (
    <section aria-label="Khách nhập và ghi chú CS" className={`${card} flex flex-wrap gap-x-[20px] gap-y-md px-md pt-sm pb-md`}>
      <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-sm">
        <div className="flex items-center gap-sm">
          <span className="text-body-sm font-semibold text-on-surface">Khách nhập</span>
          <span className="text-label-sm text-on-surface-variant">{count}</span>
          <button type="button" onClick={onRefresh} disabled={refreshing} title="Nạp lại dữ liệu custom từ Shopify" className={`${btnText} ml-auto`}>
            <Icon name="refresh" className={`text-[18px] ${refreshing ? 'animate-spin' : ''}`} />{refreshing ? 'Đang nạp…' : 'Nạp lại'}
          </button>
        </div>
        {line.attributesLoaded && fields.length === 0 && line.customallPending && (
          <div role="alert" className="flex items-center gap-sm rounded-lg bg-error-container/60 border border-error/30 px-sm py-sm text-body-sm text-on-error-container">
            <Icon name="error" className="text-[20px] text-error" />
            <span className="flex-1">Chưa lấy được text khách gõ từ Customall — bấm Nạp lại, đừng đọc tên từ ảnh mockup.</span>
            {line.customerDesignLink && (
              <a href={line.customerDesignLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[2px] font-semibold whitespace-nowrap hover:underline">
                Mở thiết kế khách<Icon name="open_in_new" className="text-[15px]" />
              </a>
            )}
          </div>
        )}
        {!line.attributesLoaded && <span className="text-body-sm text-on-surface-variant">Chưa có dữ liệu custom cho dòng này — bấm Nạp lại.</span>}
        {line.attributesLoaded && fields.length === 0 && !line.customallPending && (
          <span className="text-body-sm text-on-surface-variant">{line.customized ? 'Khách không nhập trường nào.' : 'Non-custom: 1 design cho SKU × xưởng.'}</span>
        )}
        {fields.length > 0 && (
          <div className="flex flex-wrap gap-sm">
            {fields.map((f, i) => {
              const layer = layerLabel(f.key, detail)
              const long = f.value.length > 14
              const special = hasNonAscii(f.value)
              return (
                <div key={`${f.key}-${i}`} className={`flex flex-col gap-xs min-w-[180px] max-w-full rounded-lg px-sm py-sm ${layer.missing ? 'bg-error-container/50 border border-error/30' : 'bg-surface-container-low'}`}>
                  <div className="flex items-center gap-xs flex-wrap">
                    <span className="text-label-sm text-on-surface-variant">{i + 1}. {f.key}</span>
                    {f.source === 'customall' && <span title="Text khách gõ, lấy từ dữ liệu Customall lưu cho đơn này" className="text-[11px] font-semibold text-secondary">Customall</span>}
                    {layer.missing
                      ? <span title={layer.title} className="inline-flex items-center h-[18px] px-[6px] rounded-full bg-error text-on-error text-[11px] font-semibold">PSD thiếu layer</span>
                      : layer.text && <span title={layer.title} className="font-mono text-[11px] text-secondary">{layer.text}</span>}
                  </div>
                  <div className="flex items-center gap-xs">
                    <span className="font-mono text-body-md font-medium text-on-surface whitespace-pre-wrap break-all">{f.value}</span>
                    <button type="button" aria-label={`Copy ${f.key}`} title="Copy giá trị"
                      onClick={async () => toast.say(await copyText(f.value) ? `Đã chép "${f.value}"` : 'Không chép được', 'ok')}
                      className="inline-grid place-items-center w-7 h-7 rounded-lg bg-surface-container-lowest text-on-surface-variant hover:text-secondary shrink-0">
                      <Icon name="content_copy" className="text-[16px]" />
                    </button>
                  </div>
                  {(long || special) && (
                    <div className="flex flex-wrap gap-xs">
                      {long && <span title="Dài hơn 14 ký tự — kiểm tra có tràn layer không" className="inline-flex items-center h-5 px-[6px] rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold">{f.value.length} ký tự</span>}
                      {special && <span title="Có ký tự đặc biệt — kiểm tra font có hỗ trợ" className="inline-flex items-center h-5 px-[6px] rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold">ký tự đặc biệt</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <CsNote detail={detail} lastAsk={lastAsk} onChanged={onChanged} />
    </section>
  )
}
