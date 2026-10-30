'use client'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import type { TaskDetail, TaskStatus, TransitionBody } from './types'
import { allSlotsFilled, canMove, copyText, newestFor, postJson, printPartNames, productPageUrl, requestJson, taskImages, taskUrl, timeLeft } from './model'
import { machineQa } from './ai-qa'
import { reviewVerdict, type ReviewVerdict } from './review-check'
import { printFileFit } from '@/lib/print-file-fit'
import { LightboxProvider } from './Lightbox'
import { ConfirmApprove } from './TaskHeader'
import CompareRow from './CompareRow'
import CustomerInputs from './CustomerInputs'
import PrintFileThumb from './PrintFileThumb'
import ActivityPanel from './ActivityPanel'
import { useShopifyRefresh } from './useShopifyRefresh'
import { PopoverHead, useDismiss, useToast } from './overlay'
import { Avatar, ErrorBanner, Icon, Pill, STATUS_META, btnMd, btnPrimaryMd, card, field, fieldLabel, fmtDate, fmtDateTime, iconBtn, menuItem, popover } from './ui'

type Panel = 'none' | 'reject' | 'menu'

function VerdictStrip({ v }: { v: ReviewVerdict }) {
  if (v.status === 'ok') {
    return (
      <div className="flex items-center gap-sm px-[20px] py-sm border-t border-outline-variant/20 bg-tertiary/10 rounded-b-xl text-body-sm">
        <Icon name="verified" className="text-[20px] text-on-tertiary-container" />
        <span className="font-semibold text-on-tertiary-container">Máy không thấy lỗi</span>
        <span className="text-on-surface-variant truncate" title={v.summary}>{v.summary}</span>
        <span className="ml-auto text-label-sm text-on-surface-variant whitespace-nowrap" title="Máy chưa so được chữ, màu và vị trí — người duyệt soi ở hàng so sánh">Còn lại: soi chữ · màu · vị trí</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-xs px-[20px] py-sm border-t border-outline-variant/20 rounded-b-xl bg-surface-container-low">
      {v.issues.map(i => (
        <div key={i.key} className="flex items-start gap-sm text-body-sm">
          <Icon name={i.level === 'error' ? 'error' : 'warning'} className={`text-[20px] ${i.level === 'error' ? 'text-error' : 'text-amber-600'}`} />
          <span className={i.level === 'error' ? 'text-on-error-container font-semibold' : 'text-amber-900'}>{i.text}</span>
        </div>
      ))}
      {v.summary && <span className="text-label-sm text-on-surface-variant pl-[28px]">{v.summary}</span>}
    </div>
  )
}

function PrintFiles({ detail }: { detail: TaskDetail }) {
  const { line, slots, template } = detail
  const parts = printPartNames(line, slots)
  const wrong = (area: string) => {
    const art = newestFor(line, area, 'PRINT')
    return !!art && printFileFit(template, area, art).state === 'bad'
  }
  return (
    <section aria-label="File in" className={`${card} px-md pt-sm pb-md flex flex-col gap-sm`}>
      <div className="flex items-center gap-sm">
        <Icon name="print" className="text-[20px] text-on-surface-variant" />
        <span className="text-body-sm font-semibold text-on-surface">File in</span>
        <span className="text-label-sm text-on-surface-variant">{parts.length} vùng · bấm để xem lớn</span>
      </div>
      {parts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-error/50 px-md py-lg text-center text-body-sm text-error">Chưa có file in</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-sm">
          {parts.map(area => <PrintFileThumb key={area} line={line} area={area} refLabel={detail.task.taskKey} wrongSize={wrong(area)} />)}
        </div>
      )}
    </section>
  )
}

function ReviewHeader({ detail, verdict, position, busy, refreshing, onApprove, onReject, onRefresh, onOpenTask }: {
  detail: TaskDetail; verdict: ReviewVerdict; position: { index: number; total: number }; busy: boolean; refreshing: boolean
  onApprove: () => void; onReject: (reasons: string[], note: string) => Promise<boolean>; onRefresh: () => void; onOpenTask: () => void
}) {
  const { task, line, settings } = detail
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>('none')
  const [reasons, setReasons] = useState<string[]>([])
  const [note, setNote] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setPanel('none')
  useDismiss(ref, panel !== 'none', close)
  const left = timeLeft(task)
  const status = STATUS_META[task.status]
  const inReview = task.status === 'REVIEW'
  const canApprove = inReview && canMove(detail, 'DONE')
  const canReject = inReview && canMove(detail, 'REJECTED')

  async function submitReject(e: FormEvent) {
    e.preventDefault()
    if (reasons.length === 0) return
    if (await onReject(reasons, note.trim())) { close(); setReasons([]); setNote('') }
  }
  async function copy(value: string) { toast.say(await copyText(value) ? `Đã chép "${value}"` : 'Không chép được') }

  const links: { href: string; label: string; icon: string; internal?: boolean }[] = [
    ...(detail.profileRouteKey ? [{ href: productPageUrl(detail.profileRouteKey), label: 'Mở trang sản phẩm (mapping · artwork)', icon: 'inventory_2', internal: true }] : []),
    ...(line.libraryDesignLink ? [{ href: line.libraryDesignLink, label: 'Design Library', icon: 'photo_library' }] : []),
    ...(line.customizedUrl ? [{ href: line.customizedUrl, label: 'Customized URL', icon: 'link' }] : []),
    ...(detail.driveFolder ? [{ href: detail.driveFolder.url, label: 'Thư mục Drive của task', icon: 'folder_open' }] : []),
  ]

  return (
    <section aria-label={`Duyệt ${task.taskKey}`} className="sticky top-0 z-30 bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20">
      <div className="flex flex-wrap items-center gap-x-md gap-y-sm px-[20px] pt-md pb-sm">
        <div className="flex-[999_1_520px] min-w-0 flex flex-col gap-xs">
          <div className="flex flex-wrap items-center gap-sm">
            <h2 className="font-mono text-[22px] leading-7 font-bold tracking-tight text-on-surface">{task.taskKey}</h2>
            <button type="button" onClick={() => copy(task.taskKey)} aria-label="Copy Task ID" title="Copy Task ID" className={`${iconBtn} w-7 h-7`}><Icon name="content_copy" className="text-[16px]" /></button>
            {!inReview && <Pill tone={status.tone} size="md">{status.label}</Pill>}
            <Pill tone={left.tone} icon={left.icon} size="md" title={`Hạn: ${task.dueAt ? fmtDateTime(task.dueAt) : 'chưa đặt'} · đặt ${fmtDate(task.placedAt)}`}>{left.label}</Pill>
            {line.artworks.some(a => a.source === 'AUTO') && <Pill tone="brand" icon="auto_awesome" size="md">Tự động</Pill>}
            <span className="w-px h-5 bg-outline-variant mx-xs" />
            <span className="inline-flex items-center gap-xs text-body-sm text-on-surface">
              {task.assigneeName ? <Avatar name={task.assigneeName} size="md" /> : <Icon name="person" className="text-[18px] text-on-surface-variant" />}
              {task.assigneeName ?? 'Chưa giao'}
            </span>
            <span className="ml-auto text-label-sm text-on-surface-variant whitespace-nowrap">Mẫu {position.index + 1}/{position.total}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-md gap-y-xs text-body-sm text-on-surface-variant">
            <span className="font-semibold text-on-surface">{task.productTitle}</span>
            {line.variantTitle && (
              <span className="inline-flex items-center gap-xs h-7 px-[10px] rounded-lg bg-on-surface text-surface text-[13px] leading-[18px]">
                <span className="opacity-70">Biến thể</span><span className="font-semibold">{line.variantTitle}</span>
              </span>
            )}
            <span>SL <b className="text-on-surface">{line.qty}</b></span>
            <span className="text-outline-variant">·</span>
            <span>Đơn <span className="font-mono text-on-surface">{task.orderNumber}</span> · {task.storeName}</span>
            {line.supplier && <><span className="text-outline-variant">·</span><span>Xưởng <b className="text-on-surface">{line.supplier.name}</b>{line.supplierSku ? ` ${line.supplierSku}` : ''}</span></>}
          </div>
        </div>

        <div ref={ref} className="relative flex-auto flex items-center justify-end gap-sm">
          {canReject && (
            <button type="button" className={btnMd} disabled={busy} aria-haspopup="dialog" aria-expanded={panel === 'reject'} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setReasons([]) }}>
              <Icon name="assignment_return" className="text-[18px] text-on-surface-variant" />Trả lại sửa
            </button>
          )}
          {canApprove ? (
            <button type="button" className={btnPrimaryMd} disabled={busy} onClick={onApprove}>
              {verdict.status === 'error' ? 'Vẫn duyệt' : 'Duyệt design'}<Icon name="verified" className="text-[18px]" />
            </button>
          ) : inReview ? (
            <button type="button" className={btnPrimaryMd} disabled title="Leader duyệt design">Chờ leader duyệt<Icon name="hourglass_top" className="text-[18px]" /></button>
          ) : (
            <button type="button" className={btnPrimaryMd} onClick={onOpenTask}>Mở task<Icon name="open_in_full" className="text-[18px]" /></button>
          )}
          <button type="button" onClick={() => setPanel(panel === 'menu' ? 'none' : 'menu')} aria-label="Thêm thao tác" aria-haspopup="menu" aria-expanded={panel === 'menu'}
            className="inline-grid place-items-center w-10 h-10 rounded-lg border border-outline-variant bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low">
            <Icon name="more_horiz" className="text-[20px]" />
          </button>

          {panel === 'reject' && (
            <form role="dialog" aria-label="Trả lại sửa" onSubmit={submitReject} className={`${popover} top-12 right-12 w-[400px] p-md flex flex-col gap-sm`}>
              <PopoverHead title="Trả lại sửa" onClose={close} />
              <div className="flex flex-col gap-xs">
                <span className="text-label-sm text-on-surface-variant">Lý do (chọn nhiều)</span>
                <div className="flex flex-wrap gap-xs">
                  {settings.rejectReasons.map(r => {
                    const on = reasons.includes(r)
                    return (
                      <button key={r} type="button" aria-pressed={on} onClick={() => setReasons(on ? reasons.filter(x => x !== r) : [...reasons, r])}
                        className={`inline-flex items-center gap-xs h-8 px-sm rounded-full border text-label-sm ${on ? 'bg-secondary/10 border-secondary text-secondary font-semibold' : 'bg-surface-container-lowest border-outline-variant text-on-surface'}`}>
                        {on && <Icon name="check" className="text-[16px]" />}{r}
                      </button>
                    )
                  })}
                </div>
              </div>
              <label className={fieldLabel}>Ghi chú cho designer
                <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Vd. tên đang là Emely, khách nhập Emily" className={`${field} h-auto py-sm`} />
              </label>
              <div className="flex justify-end gap-sm">
                <button type="button" className={btnMd} onClick={close}>Huỷ</button>
                <button type="submit" className={btnPrimaryMd} disabled={busy || reasons.length === 0}>Trả lại · {reasons.length} lý do</button>
              </div>
            </form>
          )}

          {panel === 'menu' && (
            <div role="menu" aria-label="Thao tác duyệt" className={`${popover} top-12 right-0 w-[320px] p-xs flex flex-col`}>
              <button type="button" role="menuitem" className={menuItem} onClick={() => { close(); onOpenTask() }}>
                <Icon name="edit_document" className="text-[18px] text-on-surface-variant" /><span className="flex-1">Mở task để sửa file</span>
              </button>
              <button type="button" role="menuitem" className={menuItem} disabled={refreshing} onClick={() => { close(); onRefresh() }}>
                <Icon name="sync" className="text-[18px] text-on-surface-variant" /><span className="flex-1">{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}</span>
              </button>
              {links.map(l => l.internal
                ? <Link key={l.href} href={l.href} role="menuitem" className={menuItem} onClick={close}><Icon name={l.icon} className="text-[18px] text-on-surface-variant" /><span className="flex-1">{l.label}</span></Link>
                : <a key={l.href} href={l.href} target="_blank" rel="noreferrer" role="menuitem" className={menuItem} onClick={close}><Icon name={l.icon} className="text-[18px] text-on-surface-variant" /><span className="flex-1 truncate">{l.label}</span><Icon name="open_in_new" className="text-[15px] text-on-surface-variant" /></a>)}
              <div className="mx-sm my-xs px-xs py-xs rounded-lg bg-surface-container-low text-label-sm text-on-surface-variant flex flex-col gap-[2px]">
                <span><b className="text-on-surface">Giao tới:</b> {detail.order.shipTo?.countryName ?? 'chưa có địa chỉ'}</span>
                <span><b className="text-on-surface">Ngày đặt:</b> {fmtDate(task.placedAt)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <VerdictStrip v={verdict} />
    </section>
  )
}

/**
 * One task under review: what the leader approves against. The same data as the task screen, laid out for checking
 * rather than making — the compare row first, only the open issues listed, the print files as thumbnails.
 */
export default function ReviewWorkspace({ taskKey, position, onMoved, onOpenTask, onChanged }: {
  taskKey: string; position: { index: number; total: number }
  onMoved: (key: string, to: TaskStatus) => void; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const toast = useToast()
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const req = useRef(0)

  const load = useCallback(async () => {
    const id = ++req.current
    const r = await requestJson<TaskDetail>(taskUrl(taskKey))
    if (id !== req.current) return
    if (!r.ok) { setError(r.error); return }
    setError('')
    setDetail(r.data)
  }, [taskKey])
  useEffect(() => { load() }, [load])

  const refreshAll = useCallback(() => { load(); onChanged() }, [load, onChanged])
  const { refreshing, refresh } = useShopifyRefresh(detail?.task.orderId ?? '', refreshAll)

  const qa = useMemo(() => (detail ? machineQa(detail) : null), [detail])
  const verdict = useMemo(() => (detail && qa ? reviewVerdict(detail, qa) : null), [detail, qa])
  const images = useMemo(() => (detail ? taskImages(detail) : []), [detail])

  async function go(body: TransitionBody): Promise<boolean> {
    if (busy || !detail) return false
    setBusy(true)
    const r = await postJson(taskUrl(detail.task.taskKey, '/transition'), body)
    setBusy(false)
    if (!r.ok) { toast.say(r.error, 'bad'); return false }
    return true
  }

  async function approve(note?: string) {
    if (!detail) return
    const filled = allSlotsFilled(detail)
    if (await go({ to: 'DONE', note: note || undefined, ...(filled ? {} : { acceptMissingAreas: true }) })) {
      setConfirm(false)
      toast.say(`Đã duyệt design ${detail.task.taskKey}`, 'ok')
      onMoved(detail.task.taskKey, 'DONE')
    }
  }

  function onApprove() {
    if (!qa) return
    if (qa.status === 'error' || qa.status === 'none') { setConfirm(true); return }
    approve()
  }

  async function reject(reasons: string[], note: string): Promise<boolean> {
    if (!detail) return false
    const ok = await go({ to: 'REJECTED', reasons, note: note || undefined })
    if (ok) {
      toast.say(`Đã trả lại ${detail.task.taskKey} cho designer`)
      onMoved(detail.task.taskKey, 'REJECTED')
    }
    return ok
  }

  if (error) return <div className={`${card} p-md`}><ErrorBanner msg={`${taskKey}: ${error}`} /></div>
  if (!detail || !qa || !verdict) {
    return <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}><Icon name="progress_activity" className="animate-spin" />Đang tải {taskKey}…</div>
  }
  const key = detail.task.taskKey
  return (
    <LightboxProvider images={images}>
      <ReviewHeader key={`h-${key}`} detail={detail} verdict={verdict} position={position} busy={busy} refreshing={refreshing}
        onApprove={onApprove} onReject={reject} onRefresh={refresh} onOpenTask={() => onOpenTask(key)} />
      <CompareRow key={`m-${key}`} detail={detail} onChanged={refreshAll} layout="pair" />
      <CustomerInputs key={`c-${key}`} detail={detail} refreshing={refreshing} onRefresh={refresh} onChanged={refreshAll} />
      <PrintFiles key={`p-${key}`} detail={detail} />
      <ActivityPanel key={`e-${key}`} detail={detail} onChanged={refreshAll} />
      {confirm && <ConfirmApprove qa={qa} busy={busy} onCancel={() => setConfirm(false)} onConfirm={note => approve(note)} />}
    </LightboxProvider>
  )
}
