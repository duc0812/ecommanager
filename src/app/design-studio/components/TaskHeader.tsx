'use client'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import type { TaskDetail, TransitionBody } from './types'
import { OWNED_MOVES, allSlotsFilled, canMove, copyText, filesMissingHint, postJson, productPageUrl, sourceEngine, taskUrl, timeLeft } from './model'
import { buildChecklist } from './checklist'
import type { QaResult } from './ai-qa'
import { pushChipLabel } from '@/lib/handoff-shared'
import HandoffButton from './HandoffButton'
import SupplierStrip from './SupplierStrip'
import NextStepBar from './NextStepBar'
import { PopoverHead, useDismiss, useToast } from './overlay'
import {
  Avatar, Icon, Pill, READY_META, STATUS_META, btnMd, btnPrimaryMd, field, fieldLabel, fmtDate, fmtDateTime, iconBtn, menuItem, popover,
} from './ui'

type Panel = 'none' | 'reject' | 'ask' | 'assign' | 'menu'

function hoursUntil(iso: string | null, fallback: number): number {
  if (!iso) return fallback
  return Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000))
}

function ConfirmApprove({ qa, busy, onCancel, onConfirm }: { qa: QaResult; busy: boolean; onCancel: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('')
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])
  const errors = qa.status === 'none'
    ? [{ key: 'none', label: 'Chưa có file in', detail: 'Task chưa có file in nào' }]
    : qa.items.filter(i => i.level === 'error')
  return createPortal(
    <div className="fixed inset-0 z-[110] bg-on-surface/45 flex justify-center items-start pt-[20vh] p-md" onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div role="dialog" aria-modal="true" aria-label="Vẫn duyệt dù QA báo lỗi?" className="w-[500px] max-w-full rounded-xl bg-surface-container-lowest shadow-overlay p-lg flex flex-col gap-md">
        <div className="flex items-center gap-sm">
          <span className="w-10 h-10 rounded-full bg-error-container text-error grid place-items-center"><Icon name="gpp_maybe" className="text-[22px]" /></span>
          <h3 className="text-headline-sm text-on-surface">Vẫn duyệt dù QA báo lỗi?</h3>
        </div>
        <p className="text-body-sm text-on-surface-variant">
          QA phát hiện {errors.length} lỗi trên file in hiện tại. Nếu duyệt, task chuyển sang <b className="text-on-surface">Xong</b> và có thể được chuyển xưởng.
        </p>
        <div className="flex flex-col gap-sm rounded-lg bg-error-container/50 p-sm">
          {errors.map(er => (
            <div key={er.key} className="flex gap-sm">
              <Icon name="error" className="text-[18px] text-error" />
              <div className="flex flex-col"><span className="text-body-sm font-semibold text-on-error-container">{er.label}</span><span className="text-label-sm text-on-error-container">{er.detail}</span></div>
            </div>
          ))}
        </div>
        <label className={fieldLabel}>Lý do vẫn duyệt (lưu vào lịch sử)
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} autoFocus placeholder="Vd. bộ file theo mảnh, xưởng in một tờ" className={`${field} h-auto py-sm`} />
        </label>
        <div className="flex justify-end gap-sm">
          <button type="button" className={btnMd} disabled={busy} onClick={onCancel}>Quay lại xem</button>
          <button type="button" disabled={busy} onClick={() => onConfirm(note.trim())}
            className="inline-flex items-center gap-xs h-10 px-md rounded-lg bg-error text-on-error text-body-sm font-semibold hover:opacity-90 disabled:opacity-40">
            Vẫn duyệt
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default function TaskHeader({ detail, qa, holdCount, refreshing, onRefresh, onChanged }: {
  detail: TaskDetail; qa: QaResult; holdCount: Record<string, number>; refreshing: boolean; onRefresh: () => void; onChanged: () => void
}) {
  const { task, line, me, settings } = detail
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<Panel>('none')
  const [confirm, setConfirm] = useState(false)
  const [reasons, setReasons] = useState<string[]>([])
  const [rejectNote, setRejectNote] = useState('')
  const [askNote, setAskNote] = useState('')
  const [assignee, setAssignee] = useState(task.assigneeId ?? detail.assignable[0]?.id ?? '')
  const [kpi, setKpi] = useState(String(task.kpi))
  const [dueHours, setDueHours] = useState(() => String(hoursUntil(task.dueAt, task.slaHours)))
  const [assignNote, setAssignNote] = useState('')
  const actionsRef = useRef<HTMLDivElement>(null)
  const assignRef = useRef<HTMLDivElement>(null)
  const close = () => setPanel('none')
  useDismiss(actionsRef, panel === 'reject' || panel === 'ask' || panel === 'menu', close)
  useDismiss(assignRef, panel === 'assign', close)

  const owns = me.isLeader || !task.assigneeId || task.assigneeId === me.id
  const can = (to: TransitionBody['to']) => canMove(detail, to)
  const filled = allSlotsFilled(detail)
  const ready = READY_META[task.readiness]
  const status = STATUS_META[task.status]
  const left = timeLeft(task)
  const checklist = buildChecklist(detail)

  async function go(body: TransitionBody, after?: () => void) {
    if (busy) return
    setBusy(true)
    const r = await postJson(taskUrl(task.taskKey, '/transition'), body)
    setBusy(false)
    if (!r.ok) { toast.say(r.error, 'bad'); return }
    after?.()
    onChanged()
  }

  function approve() {
    if (qa.status === 'error' || qa.status === 'none') { setConfirm(true); return }
    go({ to: 'DONE' })
  }

  function submitAssign(e: FormEvent) {
    e.preventDefault()
    if (!assignee) { toast.say('Chọn người nhận việc', 'bad'); return }
    const k = Number(kpi), d = Number(dueHours)
    go({
      to: 'ASSIGNED', assigneeId: assignee,
      kpi: kpi.trim() !== '' && Number.isFinite(k) ? k : undefined,
      dueHours: Number.isFinite(d) && d > 0 ? d : undefined,
      note: assignNote.trim() || undefined,
    }, () => { setAssignNote(''); close() })
  }

  function submitReject(e: FormEvent) {
    e.preventDefault()
    if (reasons.length === 0) return
    go({ to: 'REJECTED', reasons, note: rejectNote.trim() || undefined }, () => { close(); setReasons([]); setRejectNote('') })
  }

  function submitAsk(e: FormEvent) {
    e.preventDefault()
    if (!askNote.trim()) return
    go({ to: 'ASK_CUSTOMER', note: askNote.trim() }, () => { close(); setAskNote('') })
  }

  function cancelTask() {
    close()
    if (!window.confirm(`Huỷ task ${task.taskKey}?`)) return
    go({ to: 'CANCELLED' })
  }

  async function copy(value: string) {
    toast.say(await copyText(value) ? `Đã chép "${value}"` : 'Không chép được')
  }

  const filesTitle = filled ? undefined : filesMissingHint(detail)
  let primary: ReactNode = null
  if (task.status === 'ASK_CUSTOMER' && (owns || !OWNED_MOVES.includes(detail.prevStatus ?? 'NEW'))) {
    primary = <button type="button" className={btnPrimaryMd} disabled={busy} onClick={() => go({ to: detail.prevStatus ?? 'NEW', continue: true })}>Tiếp tục<Icon name="play_arrow" className="text-[18px]" /></button>
  } else if (can('DOING') && (task.status === 'NEW' || task.status === 'ASSIGNED')) {
    primary = <button type="button" className={btnPrimaryMd} disabled={busy} onClick={() => go({ to: 'DOING' })}>Nhận việc<Icon name="front_hand" className="text-[18px]" /></button>
  } else if (can('REVIEW')) {
    primary = (
      <button type="button" className={btnPrimaryMd} disabled={busy || !filled} title={filesTitle} onClick={() => go({ to: 'REVIEW' })}>
        {task.status === 'REJECTED' ? 'Gửi duyệt lại' : 'Gửi duyệt'}<Icon name="send" className="text-[18px]" />
      </button>
    )
  } else if (can('DONE')) {
    primary = <button type="button" className={btnPrimaryMd} disabled={busy} onClick={approve}>Duyệt design<Icon name="verified" className="text-[18px]" /></button>
  } else if (task.status === 'REVIEW' && !me.canApprove) {
    primary = <button type="button" className={btnPrimaryMd} disabled title="Leader duyệt design">Chờ leader duyệt<Icon name="hourglass_top" className="text-[18px]" /></button>
  } else if (task.status === 'DONE' && detail.handoff) {
    primary = <HandoffButton orderId={task.orderId} state={detail.handoff} canHandoff={me.canHandoff} onChanged={msg => { if (msg) toast.say(msg); onChanged() }} onError={m => toast.say(m, 'bad')} />
  }

  const secondaries: ReactNode[] = []
  if (can('ASK_CUSTOMER')) {
    secondaries.push(<button key="ask" type="button" className={btnMd} disabled={busy} aria-haspopup="dialog" aria-expanded={panel === 'ask'} onClick={() => setPanel(panel === 'ask' ? 'none' : 'ask')}><Icon name="contact_support" className="text-[18px] text-on-surface-variant" />Hỏi khách</button>)
  }
  if (can('REJECTED')) {
    secondaries.push(<button key="reject" type="button" className={btnMd} disabled={busy} aria-haspopup="dialog" aria-expanded={panel === 'reject'} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setReasons([]) }}><Icon name="assignment_return" className="text-[18px] text-on-surface-variant" />Trả lại sửa</button>)
  }
  if (task.status === 'DONE' && can('DOING')) {
    secondaries.push(<button key="reopen" type="button" className={btnMd} disabled={busy} onClick={() => go({ to: 'DOING' })}><Icon name="edit" className="text-[18px] text-on-surface-variant" />Sửa &amp; gửi lại</button>)
  }

  const canDeny = can('NEW') && (!me.isLeader || task.assigneeId === me.id)
  const canCancel = can('CANCELLED')
  const links: { href: string; label: string; icon: string; internal?: boolean }[] = [
    ...(detail.profileRouteKey ? [{ href: productPageUrl(detail.profileRouteKey), label: 'Mở trang sản phẩm (mapping · artwork)', icon: 'inventory_2', internal: true }] : []),
    ...(line.libraryDesignLink ? [{ href: line.libraryDesignLink, label: 'Design Library', icon: 'photo_library' }] : []),
    ...(line.customizedUrl ? [{ href: line.customizedUrl, label: 'Customized URL', icon: 'link' }] : []),
    ...line.sourcePrintFiles.map(f => ({ href: f.url, label: `_print_files · ${f.printArea}`, icon: 'attach_file' })),
    ...(detail.order.trelloCardUrl ? [{ href: detail.order.trelloCardUrl, label: 'Thẻ Trello', icon: 'view_kanban' }] : []),
  ]
  const shipTo = detail.order.shipTo
  const canAssign = can('ASSIGNED')

  return (
    <section aria-label={`Task ${task.taskKey}`} className="sticky top-0 z-30 bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20">
      <div className="flex flex-wrap items-center gap-x-md gap-y-sm px-[20px] pt-md pb-sm">
        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h2 className="font-mono text-[22px] leading-7 font-bold tracking-tight text-on-surface">{task.taskKey}</h2>
            <button type="button" onClick={() => copy(task.taskKey)} aria-label="Copy Task ID" title="Copy Task ID" className={`${iconBtn} w-7 h-7`}><Icon name="content_copy" className="text-[16px]" /></button>
            <Pill tone={status.tone} size="md">{status.label}</Pill>
            <Pill tone={ready.tone} icon={ready.icon} size="md"
              title={detail.profile?.status === 'READY' ? 'Hồ sơ đủ: mapping, template và artwork gốc đã đủ cho mọi biến thể' : 'Độ sẵn sàng của task'}>
              {ready.label}{detail.profile?.status === 'READY' ? ' · hồ sơ đủ' : ''}
            </Pill>
            <Pill tone={left.tone} icon={left.icon} size="md"
              title={`Hạn: ${task.dueAt ? fmtDateTime(task.dueAt) : 'chưa đặt'} · SLA ${task.slaHours}h · KPI ${task.kpi} · đặt ${fmtDate(task.placedAt)}`}>
              {left.label}
            </Pill>
            {detail.handoff?.push && <Pill tone="warn" icon="local_shipping" size="md">{pushChipLabel(detail.handoff.push)}</Pill>}
            {detail.handoff?.handedOff && (
              <Pill tone="ok" icon={detail.handoff.handedOff.mode === 'API' ? 'cloud_done' : 'inventory'} size="md">
                {detail.handoff.handedOff.mode === 'API' ? 'Đã chuyển supplier qua API' : 'Đã lưu chờ xuất CSV'}
              </Pill>
            )}
            {task.status === 'DONE' && detail.handoff && !detail.handoff.handedOff && (
              <Pill tone="idle" icon="local_shipping" size="md" title={detail.handoff.blocked ?? detail.handoff.apiNote ?? undefined}>Chưa chuyển xưởng</Pill>
            )}
            <span className="w-px h-5 bg-outline-variant mx-xs" />
            <div ref={assignRef} className="relative">
              <button type="button" onClick={() => canAssign && setPanel(panel === 'assign' ? 'none' : 'assign')} aria-haspopup={canAssign ? 'dialog' : undefined}
                aria-expanded={canAssign ? panel === 'assign' : undefined} title={canAssign ? 'Giao việc' : `Người làm · KPI ${task.kpi} — leader giao việc`}
                className={`inline-flex items-center gap-xs h-8 pl-xs pr-sm rounded-full border border-outline-variant bg-surface-container-lowest text-body-sm text-on-surface ${canAssign ? 'hover:bg-surface-container-low' : 'cursor-default'}`}>
                {task.assigneeName ? <Avatar name={task.assigneeName} size="md" /> : <span className="w-6 h-6 rounded-full bg-surface-container grid place-items-center"><Icon name="person" className="text-[15px] text-on-surface-variant" /></span>}
                {task.assigneeName ?? 'Chưa giao'}
                {canAssign && <Icon name="expand_more" className="text-[16px] text-on-surface-variant" />}
              </button>
              {panel === 'assign' && (
                <form role="dialog" aria-label="Giao việc" onSubmit={submitAssign} className={`${popover} top-10 left-0 w-[340px] p-md flex flex-col gap-sm`}>
                  <PopoverHead title="Giao việc" onClose={close} />
                  <label className={fieldLabel}>Giao cho
                    <select value={assignee} onChange={e => setAssignee(e.target.value)} className={field}>
                      {detail.assignable.length === 0 && <option value="">— không có người —</option>}
                      {detail.assignable.map(u => <option key={u.id} value={u.id}>{u.name} · đang giữ {holdCount[u.id] ?? 0}</option>)}
                    </select>
                  </label>
                  <div className="flex gap-sm">
                    <label className={`${fieldLabel} flex-1`}>Điểm KPI<input type="number" step="0.05" min="0" value={kpi} onChange={e => setKpi(e.target.value)} className={field} /></label>
                    <label className={`${fieldLabel} flex-1`}>Hạn (giờ)<input type="number" min="1" value={dueHours} onChange={e => setDueHours(e.target.value)} className={field} /></label>
                  </div>
                  <label className={fieldLabel}>Yêu cầu
                    <textarea rows={2} value={assignNote} onChange={e => setAssignNote(e.target.value)} placeholder="Vd. dựng lại từ master" className={`${field} h-auto py-sm`} />
                  </label>
                  <div className="flex justify-end gap-sm">
                    <button type="button" className={btnMd} onClick={close}>Huỷ</button>
                    <button type="submit" className={btnPrimaryMd} disabled={busy || !assignee}>{task.assigneeId ? 'Giao lại' : 'Giao việc'}</button>
                  </div>
                </form>
              )}
            </div>
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
            <span className="inline-flex items-center gap-xs">
              Đơn <span className="font-mono text-on-surface">{task.orderNumber}</span> · dòng {task.linePosition}
              <button type="button" onClick={() => copy(task.orderNumber.replace(/^#/, ''))} aria-label="Copy mã đơn" title="Copy mã đơn" className={`${iconBtn} w-6 h-6`}><Icon name="content_copy" className="text-[15px]" /></button>
            </span>
            <span className="text-outline-variant">·</span>
            <span>Store {task.storeName}</span>
            {task.sku && <><span className="text-outline-variant">·</span><span className="inline-flex items-center gap-xs">SKU <span className="font-mono text-on-surface">{task.sku}</span>
              <button type="button" onClick={() => copy(task.sku!)} aria-label="Copy SKU" title="Copy SKU" className={`${iconBtn} w-6 h-6`}><Icon name="content_copy" className="text-[15px]" /></button></span></>}
          </div>
        </div>

        <div ref={actionsRef} className="relative flex-auto flex items-center justify-end gap-sm">
          {secondaries}
          {primary}
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
                <textarea rows={3} value={rejectNote} onChange={e => setRejectNote(e.target.value)} placeholder="Vd. tên đang là Emely, khách nhập Emily" className={`${field} h-auto py-sm`} />
              </label>
              <div className="flex justify-end gap-sm">
                <button type="button" className={btnMd} onClick={close}>Huỷ</button>
                <button type="submit" className={btnPrimaryMd} disabled={busy || reasons.length === 0}>Trả lại · {reasons.length} lý do</button>
              </div>
            </form>
          )}

          {panel === 'ask' && (
            <form role="dialog" aria-label="Hỏi khách" onSubmit={submitAsk} className={`${popover} top-12 right-12 w-[380px] p-md flex flex-col gap-sm`}>
              <PopoverHead title="Hỏi khách" onClose={close} />
              <span className="text-[13px] leading-[18px] text-on-surface-variant">CS sẽ gửi câu hỏi cho khách. Task chuyển sang <b className="text-on-surface">Hỏi khách</b> cho tới khi bấm Tiếp tục.</span>
              <label className={fieldLabel}>Nội dung cần hỏi
                <textarea rows={4} autoFocus value={askNote} onChange={e => setAskNote(e.target.value)} placeholder="Vd. Bạn muốn năm 2026 in ở mặt trước hay mặt sau?" className={`${field} h-auto py-sm`} />
              </label>
              <div className="flex justify-end gap-sm">
                <button type="button" className={btnMd} onClick={close}>Huỷ</button>
                <button type="submit" className={btnPrimaryMd} disabled={busy || !askNote.trim()}>Chuyển CS hỏi khách</button>
              </div>
            </form>
          )}

          {panel === 'menu' && (
            <div role="menu" aria-label="Thao tác task" className={`${popover} top-12 right-0 w-[320px] p-xs flex flex-col`}>
              <button type="button" role="menuitem" className={menuItem} disabled={refreshing} onClick={() => { close(); onRefresh() }}>
                <Icon name="sync" className="text-[18px] text-on-surface-variant" /><span className="flex-1">{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}</span>
              </button>
              {links.map(l => l.internal
                ? <Link key={l.href} href={l.href} role="menuitem" className={menuItem} onClick={close}><Icon name={l.icon} className="text-[18px] text-on-surface-variant" /><span className="flex-1">{l.label}</span></Link>
                : <a key={l.href} href={l.href} target="_blank" rel="noreferrer" role="menuitem" className={menuItem} onClick={close}><Icon name={l.icon} className="text-[18px] text-on-surface-variant" /><span className="flex-1 truncate">{l.label}</span><Icon name="open_in_new" className="text-[15px] text-on-surface-variant" /></a>)}
              <div className="mx-sm my-xs px-xs py-xs rounded-lg bg-surface-container-low text-label-sm text-on-surface-variant flex flex-col gap-[2px]">
                <span><b className="text-on-surface">Giao tới:</b> {shipTo?.countryName ? `${shipTo.countryName}${shipTo.countryCode ? ` (${shipTo.countryCode})` : ''}${shipTo.place ? ` · ${shipTo.place}` : ''}` : 'chưa có địa chỉ'}</span>
                <span><b className="text-on-surface">Ngày đặt:</b> {fmtDate(task.placedAt)}</span>
                <span><b className="text-on-surface">Nguồn:</b> {sourceEngine(line)}</span>
              </div>
              {(canDeny || canCancel) && <div role="separator" className="h-px mx-sm my-xs bg-outline-variant/60" />}
              {canDeny && (
                <button type="button" role="menuitem" className={menuItem} disabled={busy} onClick={() => { close(); go({ to: 'NEW' }) }}>
                  <Icon name="block" className="text-[18px] text-on-surface-variant" /><span className="flex-1">Từ chối task</span>
                </button>
              )}
              {canCancel && (
                <button type="button" role="menuitem" className={`${menuItem} text-error`} disabled={busy} onClick={cancelTask}>
                  <Icon name="cancel" className="text-[18px]" /><span className="flex-1">Huỷ task</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <SupplierStrip detail={detail} />
      <NextStepBar checklist={checklist} onRefresh={onRefresh} refreshing={refreshing} />

      {confirm && (
        <ConfirmApprove qa={qa} busy={busy} onCancel={() => setConfirm(false)}
          onConfirm={note => go({ to: 'DONE', note: note || undefined, ...(filled ? {} : { acceptMissingAreas: true }) }, () => setConfirm(false))} />
      )}
    </section>
  )
}
