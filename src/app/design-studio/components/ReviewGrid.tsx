'use client'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Me, ReviewCard } from './types'
import { postJson, requestJson, taskImages, taskUrl, timeLeft } from './model'
import { LightboxProvider, useLightbox } from './Lightbox'
import PrintFileThumb from './PrintFileThumb'
import { pushChipLabel } from '@/lib/handoff-shared'
import { ErrorBanner, Icon, Pill, btn, btnPrimary, btnWarn, card, input } from './ui'

type ReviewResponse = { cards: ReviewCard[]; rejectReasons: string[]; me: Me }

function ShopifyImage({ c }: { c: ReviewCard }) {
  const lb = useLightbox()
  const url = c.line.previewUrl ?? c.line.imageUrl
  const label = c.line.previewUrl ? 'Preview khách' : 'Ảnh variant'
  if (!url) return <div className="w-24 aspect-square rounded-md bg-surface-container-high grid place-items-center text-on-surface-variant"><Icon name="image_not_supported" /></div>
  return (
    <button type="button" onClick={() => lb?.open(url)} aria-label={`Xem ${label.toLowerCase()} ${c.task.taskKey}`} className="flex flex-col gap-[2px] w-24 shrink-0 text-left">
      <span className="w-24 aspect-square rounded-md overflow-hidden border border-outline-variant/30 bg-surface-container-high">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={`${label} ${c.task.taskKey}`} loading="lazy" className="w-full h-full object-cover" />
      </span>
      <span className="text-[11px] text-on-surface-variant">{label}</span>
    </button>
  )
}

function Card({ c, me, reasons, selected, busy, onToggle, onApprove, onReject, onOpen }: {
  c: ReviewCard; me: Me | null; reasons: string[]; selected: boolean; busy: boolean
  onToggle: () => void; onApprove: () => void; onReject: (reasons: string[], note: string) => Promise<boolean>; onOpen: () => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [note, setNote] = useState('')
  const images = useMemo(() => taskImages(c), [c])
  const { task, line } = c
  const auto = line.artworks.some(a => a.source === 'AUTO')
  const left = timeLeft(task)
  const leader = !!me?.canApprove

  async function submitReject(e: FormEvent) {
    e.preventDefault()
    if (picked.length === 0) return
    if (await onReject(picked, note.trim())) { setRejecting(false); setPicked([]); setNote('') }
  }

  return (
    <LightboxProvider images={images}>
      <article aria-label={`Mẫu ${task.taskKey}`} className={`${card} flex flex-col ${selected ? 'ring-2 ring-secondary/50' : ''}`}>
        <header className="flex items-center gap-sm flex-wrap px-md py-sm border-b border-outline-variant/20">
          {leader && (
            <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Chọn ${task.taskKey}`} className="w-4 h-4 accent-secondary" />
          )}
          <span className="font-mono font-semibold text-body-sm text-on-surface">{task.taskKey}</span>
          {auto && <Pill tone="brand" icon="auto_awesome">Tự động</Pill>}
          {c.push && (
            <span title="Đơn này đã được gửi sang PGprints — duyệt xong đơn sẽ tự chuyển Exported, không cần gửi lại">
              <Pill tone="warn" icon="local_shipping">{pushChipLabel(c.push)}</Pill>
            </span>
          )}
          <span className="ml-auto"><Pill tone={left.tone} icon={left.icon}>{left.label}</Pill></span>
        </header>
        <div className="p-md flex gap-md">
          <div className={`flex-1 min-w-0 grid gap-sm ${c.slots.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {c.slots.map(area => <PrintFileThumb key={area} line={c.line} area={area} refLabel={c.task.taskKey} />)}
          </div>
          <ShopifyImage c={c} />
        </div>
        <div className="px-md pb-sm flex flex-col gap-xs text-body-sm min-w-0">
          <span className="text-on-surface font-semibold truncate" title={task.productTitle}>{task.productTitle}</span>
          {task.variantTitle && <span className="text-label-sm text-on-surface-variant">{task.variantTitle}</span>}
          {line.personalization.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-sm gap-y-[2px] text-label-sm">
              {line.personalization.map((p, i) => (
                <div key={`${p.key}-${i}`} className="contents">
                  <dt className="text-on-surface-variant">{p.key}:</dt>
                  <dd className="text-on-surface font-semibold break-words">{p.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {task.assigneeName && <span className="text-label-sm text-on-surface-variant">Designer: {task.assigneeName}</span>}
        </div>
        <div className="mt-auto px-md py-sm border-t border-outline-variant/20 flex items-center gap-xs flex-wrap">
          {leader ? (
            <>
              <button type="button" className={btnPrimary} disabled={busy} onClick={onApprove}>
                <Icon name="verified" className="text-[16px]" />Duyệt design
              </button>
              <button type="button" className={btnWarn} disabled={busy} aria-expanded={rejecting} onClick={() => setRejecting(!rejecting)}>
                <Icon name="undo" className="text-[16px]" />Trả lại sửa
              </button>
            </>
          ) : (
            <span className="inline-flex items-center gap-xs text-label-sm font-semibold text-on-surface-variant">
              <Icon name="hourglass_top" className="text-[16px]" />Chờ leader duyệt
            </span>
          )}
          <button type="button" className={`${btn} ml-auto`} onClick={onOpen}>
            <Icon name="open_in_full" className="text-[16px]" />Mở task
          </button>
        </div>
        {leader && rejecting && (
          <form onSubmit={submitReject} aria-label={`Trả lại ${task.taskKey}`} className="mx-md mb-md flex flex-col gap-xs p-sm rounded-lg bg-surface-container-low border border-outline-variant/20">
            <b className="text-label-sm text-on-surface">Lý do trả lại</b>
            <div className="flex flex-wrap gap-xs">
              {reasons.map(r => {
                const on = picked.includes(r)
                return (
                  <button key={r} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter(x => x !== r) : [...picked, r])}
                    className={`rounded-full px-sm py-[2px] text-label-sm border ${on ? 'bg-error-container text-on-error-container border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`}>
                    {r}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-xs">
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ghi chú cụ thể…" aria-label={`Ghi chú trả lại ${task.taskKey}`} className={`${input} flex-1`} />
              <button type="submit" className={btnWarn} disabled={busy || picked.length === 0}><Icon name="undo" className="text-[16px]" />Trả lại</button>
            </div>
          </form>
        )}
      </article>
    </LightboxProvider>
  )
}

export default function ReviewGrid({ mine, q, version, onOpenTask, onChanged }: {
  mine: boolean; q: string; version: number; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const [cards, setCards] = useState<ReviewCard[]>([])
  const [reasons, setReasons] = useState<string[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [info, setInfo] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string[]>([])
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (mine) qs.set('mine', '1')
    if (q) qs.set('q', q)
    const query = qs.toString()
    const r = await requestJson<ReviewResponse>(`/api/design-studio/tasks/review${query ? `?${query}` : ''}`)
    setLoading(false)
    if (!r.ok) { setError(r.status === 0 ? 'Mất kết nối tới máy chủ — bấm "Tải lại" để thử lại' : r.error); return }
    setError('')
    setCards(r.data.cards)
    setReasons(r.data.rejectReasons)
    setMe(r.data.me)
    setSelected(sel => sel.filter(k => r.data.cards.some(c => c.task.taskKey === k)))
  }, [mine, q])

  useEffect(() => { load() }, [load, version])

  const drop = (keys: string[]) => {
    setCards(cs => cs.filter(c => !keys.includes(c.task.taskKey)))
    setSelected(sel => sel.filter(k => !keys.includes(k)))
  }

  async function move(key: string, body: Record<string, unknown>): Promise<string | null> {
    setBusy(b => [...b, key])
    const r = await postJson(taskUrl(key, '/transition'), body)
    setBusy(b => b.filter(k => k !== key))
    return r.ok ? null : r.error
  }

  async function approve(key: string) {
    setActionError(''); setInfo('')
    const err = await move(key, { to: 'DONE' })
    if (err) { setActionError(`${key}: ${err}`); return }
    drop([key])
    setInfo(`Đã duyệt design ${key}`)
    onChanged()
  }

  async function reject(key: string, picked: string[], note: string): Promise<boolean> {
    setActionError(''); setInfo('')
    const err = await move(key, { to: 'REJECTED', reasons: picked, note: note || undefined })
    if (err) { setActionError(`${key}: ${err}`); return false }
    drop([key])
    setInfo(`Đã trả lại ${key} cho designer`)
    onChanged()
    return true
  }

  async function approveSelected() {
    const keys = [...selected]
    if (keys.length === 0 || batch) return
    if (!window.confirm(`Duyệt design ${keys.length} mẫu đã chọn?`)) return
    setActionError(''); setInfo('')
    const ok: string[] = []
    const failed: string[] = []
    setBatch({ done: 0, total: keys.length })
    for (const key of keys) {
      const err = await move(key, { to: 'DONE' })
      if (err) failed.push(`${key}: ${err}`)
      else ok.push(key)
      setBatch({ done: ok.length + failed.length, total: keys.length })
    }
    setBatch(null)
    drop(ok)
    if (ok.length) setInfo(`Đã duyệt design ${ok.length} mẫu`)
    if (failed.length) setActionError(`Không duyệt được ${failed.length} mẫu — ${failed.join(' · ')}`)
    onChanged()
  }

  const leader = !!me?.canApprove
  const allSelected = cards.length > 0 && selected.length === cards.length

  return (
    <section aria-label="Duyệt mẫu" className="flex flex-col gap-md min-w-0">
      <div className={`${card} px-md py-sm flex items-center gap-sm flex-wrap`}>
        <Icon name="fact_check" className="text-secondary text-[20px]" />
        <h2 className="text-body-md font-semibold text-on-surface">Duyệt mẫu</h2>
        <span className="text-label-sm text-on-surface-variant">{cards.length} mẫu chờ duyệt · bấm ảnh để xem lớn</span>
        {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
        <span className="ml-auto flex items-center gap-sm flex-wrap">
          {leader && cards.length > 0 && (
            <>
              <label className="inline-flex items-center gap-xs text-label-sm text-on-surface-variant">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : cards.map(c => c.task.taskKey))} className="w-4 h-4 accent-secondary" />
                Chọn tất cả
              </label>
              <button type="button" className={btnPrimary} disabled={selected.length === 0 || !!batch} onClick={approveSelected}>
                <Icon name="done_all" className="text-[16px]" />
                {batch ? `Đang duyệt ${batch.done}/${batch.total}…` : `Duyệt các mẫu đã chọn (${selected.length})`}
              </button>
            </>
          )}
          {!leader && me && <span className="text-label-sm text-on-surface-variant">Chờ leader duyệt — bạn chỉ xem</span>}
          <button type="button" className={btn} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
        </span>
      </div>
      {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
      <ErrorBanner msg={actionError} onClose={() => setActionError('')} />
      <ErrorBanner msg={error} />
      {!loading && !error && cards.length === 0 && (
        <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
          <Icon name="task_alt" className="text-on-tertiary-container" />Không có mẫu nào chờ duyệt.
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-md items-start">
        {cards.map(c => (
          <Card key={c.task.taskKey} c={c} me={me} reasons={reasons}
            selected={selected.includes(c.task.taskKey)} busy={busy.includes(c.task.taskKey) || !!batch}
            onToggle={() => setSelected(sel => sel.includes(c.task.taskKey) ? sel.filter(k => k !== c.task.taskKey) : [...sel, c.task.taskKey])}
            onApprove={() => approve(c.task.taskKey)}
            onReject={(picked, note) => reject(c.task.taskKey, picked, note)}
            onOpen={() => onOpenTask(c.task.taskKey)} />
        ))}
      </div>
    </section>
  )
}
