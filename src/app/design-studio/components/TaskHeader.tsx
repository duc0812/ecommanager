'use client'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import type { TaskDetail, TransitionBody } from './types'
import {
  OWNED_MOVES, allSlotsFilled, canMove, copyText, filesMissingHint, layerForField, patchJson, postJson, productPageUrl, sourceEngine, taskUrl, timeLeft,
} from './model'
import { DriveFolderLink } from './ArtworkSlots'
import { buildChecklist, type CheckItem, type CheckState } from './checklist'
import { ARTWORK_ACCEPT, MOCKUP_ACCEPT, useArtworkUpload } from './useArtworkUpload'
import type { FileKind } from './types'
import { ErrorBanner, Icon, Pill, READY_META, STATUS_META, btn, btnPrimary, btnWarn, card, input } from './ui'
import { pushChipLabel } from '@/lib/handoff-shared'
import HandoffButton from './HandoffButton'

function hasNonAscii(s: string) { return /[^\x00-\x7F]/.test(s) }

function fmtDate(iso: string) { return new Date(iso).toLocaleDateString('en-US') }
function fmtDateTime(iso: string) { return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) }

function CopyBtn({ value, label, onCopied }: { value: string; label: string; onCopied: (msg: string) => void }) {
  return (
    <button type="button" onClick={async () => onCopied(await copyText(value) ? `Đã chép "${value}"` : 'Không chép được')}
      aria-label={`Chép ${label}`} title="Chép" className="text-on-surface-variant hover:text-secondary leading-none">
      <Icon name="content_copy" className="text-[15px]" />
    </button>
  )
}

function CustomTable({ detail, onCopied }: { detail: TaskDetail; onCopied: (msg: string) => void }) {
  const { line } = detail
  if (!line.attributesLoaded) {
    return <div className="text-body-sm text-on-surface-variant">Chưa có dữ liệu custom cho dòng này — bấm &quot;Nạp lại từ Shopify&quot;.</div>
  }
  if (line.personalization.length === 0) {
    if (line.customallPending) {
      return <div className="text-body-sm text-amber-900">Chưa lấy được text khách gõ từ Customall — bấm &quot;Nạp lại từ Shopify&quot;, đừng đọc tên từ ảnh mockup.</div>
    }
    return <div className="text-body-sm text-on-surface-variant">{line.customized ? 'Khách không nhập gì.' : 'Non-custom: 1 design cho SKU × xưởng.'}</div>
  }
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
          <th className="px-xs py-xs font-medium w-6">#</th>
          <th className="px-xs py-xs font-medium">Trường</th>
          <th className="px-xs py-xs font-medium">Giá trị khách nhập</th>
          <th className="px-xs py-xs font-medium">Layer</th>
        </tr>
      </thead>
      <tbody>
        {line.personalization.map((f, i) => (
          <tr key={`${f.key}-${i}`} className="border-b border-outline-variant/20 last:border-b-0 align-top">
            <td className="px-xs py-xs text-on-surface-variant">{i + 1}</td>
            <td className="px-xs py-xs">
              <span className="flex items-center gap-xs flex-wrap">
                {f.key}
                {f.source === 'customall' && <span title="Text khách gõ, lấy từ dữ liệu Customall lưu cho đơn này"><Pill tone="brand">Customall</Pill></span>}
              </span>
            </td>
            <td className="px-xs py-xs">
              <span className="flex items-center gap-xs flex-wrap">
                <span className="font-mono font-semibold break-all text-on-surface">{f.value}</span>
                <CopyBtn value={f.value} label={f.key} onCopied={onCopied} />
                {hasNonAscii(f.value) && <Pill tone="bad">ký tự đặc biệt</Pill>}
                {f.value.length > 14 && <Pill tone="warn">{f.value.length} ký tự</Pill>}
              </span>
            </td>
            <td className="px-xs py-xs font-mono text-label-sm text-secondary"><LayerCell field={f.key} detail={detail} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LayerCell({ field, detail }: { field: string; detail: TaskDetail }) {
  const src = layerForField(field, detail.library, detail.profile?.layerMap)
  switch (src.source) {
    case 'none':
    case 'guess':
      return <span title={src.source === 'guess' ? 'Đoán theo tên trường — sản phẩm chưa có PSD' : undefined}>{src.layer}</span>
    case 'library':
      return (
        <span className="inline-flex items-center gap-xs flex-wrap" title={`Theo PSD của sản phẩm${src.optionLabel ? ` (${src.optionLabel})` : ''}`}>
          <Icon name="photo_library" className="text-[14px]" />{src.layer}
          <span className="text-on-surface-variant">· {src.fit}{src.maxChars ? ` · ≤${src.maxChars}` : ''}</span>
        </span>
      )
    case 'library-missing':
      return (
        <span className="inline-flex items-center gap-xs flex-wrap text-error" title="PSD của sản phẩm không có layer cho trường này">
          <Icon name="layers_clear" className="text-[14px]" />PSD thiếu {src.layer}
        </span>
      )
    case 'profile':
      return (
        <span className="inline-flex items-center gap-xs flex-wrap" title="Theo bảng layer cũ của hồ sơ">
          <Icon name="inventory_2" className="text-[14px]" />{src.layer}
          <span className="text-on-surface-variant">· {src.fit}{src.maxChars ? ` · ≤${src.maxChars}` : ''}</span>
        </span>
      )
  }
}

function Fact({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-xs text-on-surface-variant whitespace-nowrap"><Icon name={icon} className="text-[16px]" />{label}</dt>
      <dd className="min-w-0 flex items-center gap-xs flex-wrap text-on-surface">{children}</dd>
    </>
  )
}

function CsNote({ detail, lastAsk, onChanged }: { detail: TaskDetail; lastAsk: string | null; onChanged: () => void }) {
  const { line, task, me } = detail
  const canEdit = me.isLeader || me.canEditNote === true
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(line.designNote ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-col gap-xs w-full">
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} maxLength={2000} autoFocus aria-label="Ghi chú CS"
          placeholder="Ghi chú của CS cho designer (để trống = xoá ghi chú)" className={`${input} w-full`} />
        <span className="flex items-center gap-xs">
          <button type="submit" className={btnPrimary} disabled={busy}><Icon name="save" className="text-[16px]" />{busy ? 'Đang lưu…' : 'Lưu'}</button>
          <button type="button" className={btn} disabled={busy} onClick={() => { setEditing(false); setDraft(line.designNote ?? ''); setError('') }}>Huỷ</button>
        </span>
        <ErrorBanner msg={error} onClose={() => setError('')} />
      </form>
    )
  }
  return (
    <>
      {line.designNote || lastAsk
        ? <span className="flex flex-col">
            {line.designNote && <span className="whitespace-pre-wrap">{line.designNote}</span>}
            {lastAsk && <span className="text-amber-900">{lastAsk}</span>}
          </span>
        : <span className="text-on-surface-variant">không có</span>}
      {canEdit && (
        <button type="button" onClick={() => { setDraft(line.designNote ?? ''); setEditing(true) }} aria-label="Sửa ghi chú CS" title="Sửa ghi chú CS"
          className="text-on-surface-variant hover:text-secondary leading-none">
          <Icon name="edit" className="text-[15px]" />
        </button>
      )}
    </>
  )
}

const STATE_META: Record<CheckState, { icon: string; label: string; cls: string }> = {
  done: { icon: 'check_circle', label: 'Xong', cls: 'text-on-tertiary-container' },
  missing: { icon: 'error', label: 'Cần làm', cls: 'text-error' },
  blocked: { icon: 'lock', label: 'Đang chờ bước trước', cls: 'text-amber-900' },
  na: { icon: 'remove_circle_outline', label: 'Không áp dụng', cls: 'text-on-surface-variant' },
}

const blockHead = 'flex items-center gap-sm px-md py-sm border-b text-label-sm font-bold uppercase tracking-wider'

type Panel = 'none' | 'reject' | 'ask'

function hoursUntil(iso: string | null, fallback: number): number {
  if (!iso) return fallback
  return Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000))
}

export default function TaskHeader({ detail, holdCount, onChanged }: { detail: TaskDetail; holdCount: Record<string, number>; onChanged: () => void }) {
  const { task, line, me, settings } = detail
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [panel, setPanel] = useState<Panel>('none')
  const [reasons, setReasons] = useState<string[]>([])
  const [rejectNote, setRejectNote] = useState('')
  const [askNote, setAskNote] = useState('')
  const [assignee, setAssignee] = useState(task.assigneeId ?? detail.assignable[0]?.id ?? '')
  const [kpi, setKpi] = useState(String(task.kpi))
  const [dueHours, setDueHours] = useState(() => String(hoursUntil(task.dueAt, task.slaHours)))
  const [assignNote, setAssignNote] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const up = useArtworkUpload(detail.task.taskKey, onChanged)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<{ area: string; kind: FileKind }>({ area: '', kind: 'PRINT' })
  const askInput = useRef<HTMLInputElement>(null)

  const owns = me.isLeader || !task.assigneeId || task.assigneeId === me.id
  const can = (to: TransitionBody['to']) => canMove(detail, to)
  const filled = allSlotsFilled(detail)
  const ready = READY_META[task.readiness]
  const status = STATUS_META[task.status]
  const left = timeLeft(task)
  const checklist = buildChecklist(detail)
  const lastAsk = [...detail.events].reverse().find(e => e.type === 'ASK')

  async function go(body: TransitionBody, after?: () => void) {
    if (busy) return
    setBusy(true); setError('')
    const r = await postJson(taskUrl(task.taskKey, '/transition'), body)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    after?.()
    onChanged()
  }

  async function refreshFromShopify() {
    setRefreshing(true); setError('')
    const r = await postJson(`/api/design-studio/orders/${encodeURIComponent(task.orderId)}/refresh`, {})
    setRefreshing(false)
    if (!r.ok) { setError(r.error); return }
    const { updated = 0, unmatched = 0 } = r.data ?? {}
    setInfo(`Đã nạp lại ${updated} dòng từ Shopify${unmatched ? `, ${unmatched} dòng không khớp` : ''}`)
    onChanged()
  }

  function submitAssign(e: FormEvent) {
    e.preventDefault()
    if (!assignee) { setError('Chọn người nhận việc'); return }
    const k = Number(kpi), d = Number(dueHours)
    go({
      to: 'ASSIGNED', assigneeId: assignee,
      kpi: kpi.trim() !== '' && Number.isFinite(k) ? k : undefined,
      dueHours: Number.isFinite(d) && d > 0 ? d : undefined,
      note: assignNote.trim() || undefined,
    }, () => setAssignNote(''))
  }

  function submitReject(e: FormEvent) {
    e.preventDefault()
    if (reasons.length === 0) return
    go({ to: 'REJECTED', reasons, note: rejectNote.trim() || undefined }, () => { setPanel('none'); setReasons([]); setRejectNote('') })
  }

  function submitAsk(e: FormEvent) {
    e.preventDefault()
    if (!askNote.trim()) return
    go({ to: 'ASK_CUSTOMER', note: askNote.trim() }, () => { setPanel('none'); setAskNote('') })
  }

  function openAsk() {
    setPanel('ask')
    window.setTimeout(() => askInput.current?.focus(), 0)
  }

  function cancelTask() {
    if (!window.confirm(`Huỷ task ${task.taskKey}?`)) return
    go({ to: 'CANCELLED' })
  }

  const submitTo: TransitionBody['to'] | null = task.status === 'REVIEW'
    ? (can('DONE') ? 'DONE' : null)
    : can('REVIEW') ? 'REVIEW' : can('DONE') ? 'DONE' : null

  function checkAction(item: CheckItem): ReactNode {
    const a = item.action
    if (!a) return null
    const cls = `${item === checklist.next ? btnPrimary : btn} whitespace-nowrap`
    switch (a.kind) {
      case 'link':
        return <Link href={a.href} className={cls}><Icon name="arrow_forward" className="text-[16px]" />{a.label}</Link>
      case 'ask':
        return <button type="button" className={cls} disabled={!can('ASK_CUSTOMER') || busy} onClick={openAsk}><Icon name="contact_support" className="text-[16px]" />{a.label}</button>
      case 'refresh':
        return <button type="button" className={cls} disabled={refreshing} onClick={refreshFromShopify}><Icon name="sync" className="text-[16px]" />{refreshing ? 'Đang nạp…' : a.label}</button>
      case 'upload': {
        const kind = a.fileKind ?? 'PRINT'
        const running = a.area ? up.active.find(i => i.kind === kind && i.part === a.area) : up.active.find(i => i.kind === kind)
        return (
          <button type="button" className={cls} disabled={!!running} onClick={() => {
            uploadTarget.current = { area: a.area, kind }
            const el = uploadInput.current
            if (!el) return
            el.accept = kind === 'MOCKUP' ? MOCKUP_ACCEPT : ARTWORK_ACCEPT
            el.multiple = !a.area
            el.click()
          }}>
            <Icon name="upload" className="text-[16px]" />{running ? up.busyLabel(running.pct) : a.label}
          </button>
        )
      }
      case 'submit':
        return (
          <button type="button" className={cls} disabled={!submitTo || busy || !filled}
            title={!submitTo ? 'Không có bước này cho vai trò của bạn' : !filled ? filesMissingHint(detail) : undefined}
            onClick={() => submitTo && go({ to: submitTo })}>
            <Icon name={submitTo === 'DONE' ? 'verified' : 'send'} className="text-[16px]" />{a.label}
          </button>
        )
    }
  }

  const filesTitle = filled ? undefined : filesMissingHint(detail)
  const flow: JSX.Element[] = []
  const talk: JSX.Element[] = []
  const manage: JSX.Element[] = []
  if (task.status === 'ASK_CUSTOMER' && (owns || !OWNED_MOVES.includes(detail.prevStatus ?? 'NEW'))) {
    flow.push(<button key="continue" type="button" className={btnPrimary} disabled={busy} onClick={() => go({ to: detail.prevStatus ?? 'NEW', continue: true })}><Icon name="play_arrow" className="text-[18px]" />Tiếp tục</button>)
  }
  if (can('DOING') && (task.status === 'NEW' || task.status === 'ASSIGNED')) {
    flow.push(<button key="take" type="button" className={btnPrimary} disabled={busy} onClick={() => go({ to: 'DOING' })}><Icon name="front_hand" className="text-[18px]" />Nhận việc</button>)
  }
  if (can('REVIEW')) {
    flow.push(<button key="submit" type="button" className={btnPrimary} disabled={busy || !filled} title={filesTitle} onClick={() => go({ to: 'REVIEW' })}><Icon name="rate_review" className="text-[18px]" />Gửi duyệt</button>)
  }
  if (can('DONE')) {
    flow.push(<button key="done" type="button" className={btnPrimary} disabled={busy || !filled} title={filesTitle} onClick={() => go({ to: 'DONE' })}><Icon name="verified" className="text-[18px]" />Duyệt design</button>)
  } else if (task.status === 'REVIEW' && !me.canApprove) {
    flow.push(<button key="wait" type="button" className={btnPrimary} disabled><Icon name="hourglass_top" className="text-[18px]" />Chờ leader duyệt</button>)
  }
  if (task.status === 'DONE' && detail.handoff) {
    flow.push(
      <HandoffButton key="handoff" orderId={task.orderId} state={detail.handoff} canHandoff={me.canHandoff}
        onChanged={msg => { setError(''); if (msg) setInfo(msg); onChanged() }} onError={setError} />,
    )
  }
  if (task.status === 'DONE' && can('DOING')) {
    flow.push(<button key="reopen" type="button" className={btn} disabled={busy} onClick={() => go({ to: 'DOING' })}><Icon name="edit" className="text-[18px]" />Sửa & gửi lại</button>)
  }
  if (can('ASK_CUSTOMER')) {
    talk.push(<button key="ask" type="button" className={btnWarn} disabled={busy} aria-expanded={panel === 'ask'} onClick={() => panel === 'ask' ? setPanel('none') : openAsk()}><Icon name="contact_support" className="text-[18px]" />Hỏi khách</button>)
  }
  if (can('REJECTED')) {
    talk.push(<button key="reject" type="button" className={btnWarn} disabled={busy} aria-expanded={panel === 'reject'} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setReasons([]) }}><Icon name="undo" className="text-[18px]" />Trả lại sửa</button>)
  }
  if (can('NEW') && (!me.isLeader || task.assigneeId === me.id)) {
    manage.push(<button key="deny" type="button" className={btn} disabled={busy} onClick={() => go({ to: 'NEW' })}><Icon name="block" className="text-[18px]" />Từ chối</button>)
  }
  if (can('CANCELLED')) {
    manage.push(<button key="cancel" type="button" className={`${btn} text-error`} disabled={busy} onClick={cancelTask}><Icon name="cancel" className="text-[18px]" />Huỷ task</button>)
  }
  const groups = [
    { key: 'flow', label: 'Bước tiếp theo', items: flow },
    { key: 'talk', label: 'Trao đổi', items: talk },
    { key: 'manage', label: 'Quản lý task', items: manage },
  ].filter(g => g.items.length > 0)

  return (
    <div className="flex flex-col gap-md">
      <section aria-label={`Task ${task.taskKey}`} className={`${card} px-md py-sm flex flex-col gap-sm`}>
        <div className="flex items-center gap-sm flex-wrap">
          <h2 className="font-mono text-headline-sm text-on-surface">{task.taskKey}</h2>
          <Pill tone={status.tone}>{status.label}</Pill>
          <Pill tone={ready.tone} icon={ready.icon}>{ready.label}</Pill>
          {detail.profile?.status === 'READY' && (
            <span title="Mapping, template và artwork gốc đã đủ cho mọi biến thể của sản phẩm"><Pill tone="ok" icon="inventory_2">Hồ sơ đủ</Pill></span>
          )}
          <Pill tone={left.tone} icon={left.icon}>{left.label}</Pill>
          {detail.handoff?.push && <Pill tone="warn" icon="local_shipping">{pushChipLabel(detail.handoff.push)}</Pill>}
          {detail.handoff?.handedOff && (
            <Pill tone="ok" icon={detail.handoff.handedOff.mode === 'API' ? 'cloud_done' : 'inventory'}>
              {detail.handoff.handedOff.mode === 'API' ? 'Đã chuyển supplier qua API' : 'Đã lưu chờ xuất CSV'}
            </Pill>
          )}
          <span className="flex-1 min-w-[200px] text-body-sm text-on-surface-variant">{task.productTitle}</span>
        </div>
        {groups.length > 0 && (
          <div className="flex items-center gap-sm flex-wrap">
            {groups.map((g, i) => (
              <div key={g.key} role="group" aria-label={g.label} className={`flex items-center gap-xs flex-wrap ${i > 0 ? 'pl-sm border-l border-outline-variant/40' : ''} ${g.key === 'manage' ? 'ml-auto' : ''}`}>
                {g.items}
              </div>
            ))}
          </div>
        )}
        {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
        <ErrorBanner msg={error} onClose={() => setError('')} />
        {task.status === 'DONE' && detail.handoff && !detail.handoff.handedOff && (detail.handoff.blocked || detail.handoff.apiNote) && (
          <span className="text-label-sm text-on-surface-variant">
            <Icon name="local_shipping" className="text-[14px]" /> Chuyển supplier: {detail.handoff.blocked ?? detail.handoff.apiNote}
          </span>
        )}

        {panel === 'reject' && (
          <div className="flex flex-col gap-sm p-sm rounded-lg bg-surface-container-low border border-outline-variant/20">
            <b className="text-label-sm text-on-surface">Lý do trả lại (chọn để thống kê)</b>
            <div className="flex flex-wrap gap-xs">
              {settings.rejectReasons.map(r => {
                const on = reasons.includes(r)
                return (
                  <button key={r} type="button" aria-pressed={on} onClick={() => setReasons(on ? reasons.filter(x => x !== r) : [...reasons, r])}
                    className={`rounded-full px-sm py-[2px] text-label-sm border ${on ? 'bg-error-container text-on-error-container border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`}>
                    {r}
                  </button>
                )
              })}
            </div>
            <form onSubmit={submitReject} className="flex gap-xs">
              <input value={rejectNote} onChange={e => setRejectNote(e.target.value)} placeholder="Ghi chú cụ thể…" aria-label="Ghi chú trả lại" className={`${input} flex-1`} />
              <button type="submit" className={btnWarn} disabled={busy || reasons.length === 0}><Icon name="undo" className="text-[18px]" />Trả lại</button>
            </form>
          </div>
        )}

        {panel === 'ask' && (
          <form onSubmit={submitAsk} className="flex gap-xs p-sm rounded-lg bg-surface-container-low border border-outline-variant/20">
            <input ref={askInput} value={askNote} onChange={e => setAskNote(e.target.value)} placeholder="Cần hỏi khách điều gì?" aria-label="Nội dung hỏi khách" className={`${input} flex-1`} />
            <button type="submit" className={btnWarn} disabled={busy || !askNote.trim()}><Icon name="contact_support" className="text-[18px]" />Chuyển CS hỏi khách</button>
          </form>
        )}
      </section>

      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-md items-start">
        <section aria-labelledby="ds-info-title" className={`${card} min-w-0`}>
          <div className={`${blockHead} border-outline-variant/20 text-on-surface-variant`}>
            <Icon name="info" className="text-[18px]" />
            <span id="ds-info-title">THÔNG TIN</span>
            <button type="button" onClick={refreshFromShopify} disabled={refreshing} className={`${btn} ml-auto normal-case tracking-normal`}>
              <Icon name="sync" className="text-[16px]" />{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}
            </button>
          </div>
          <div className="px-md py-sm flex flex-col gap-md">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-md gap-y-xs text-body-sm">
              <Fact icon="receipt_long" label="Đơn">
                <b>{task.orderNumber}</b><CopyBtn value={task.orderNumber.replace(/^#/, '')} label="mã đơn" onCopied={setInfo} />
                <span className="text-on-surface-variant">· dòng {task.linePosition} · SL {line.qty}</span>
              </Fact>
              <Fact icon="storefront" label="Store">{task.storeName}</Fact>
              <Fact icon="sell" label="SKU">
                <span className="font-mono">{task.sku ?? '—'}</span>{task.sku && <CopyBtn value={task.sku} label="SKU" onCopied={setInfo} />}
                <span className="text-on-surface-variant">· biến thể</span> {line.variantTitle ?? '—'}
              </Fact>
              <Fact icon="factory" label="Xưởng">
                {line.supplier
                  ? <><b>{line.supplier.name}</b><span className="text-on-surface-variant">({line.supplier.code})</span></>
                  : <span className="text-error">chưa map{task.supplierName ? ` (trước: ${task.supplierName})` : ''}</span>}
                <span className="text-on-surface-variant">· SKU xưởng</span>
                <span className="font-mono">{line.supplierSku ?? '—'}</span>{line.supplierSku && <CopyBtn value={line.supplierSku} label="SKU xưởng" onCopied={setInfo} />}
                {line.supplierSku && <><span className="text-on-surface-variant">· sản phẩm xưởng</span>
                  {line.supplierProduct ? <b>{line.supplierProduct}</b> : <span className="text-amber-900">không có trong bảng giá xưởng</span>}</>}
              </Fact>
              <Fact icon="public" label="Giao tới">
                {detail.order.shipTo?.countryName
                  ? <><b>{detail.order.shipTo.countryName}</b>{detail.order.shipTo.countryCode && <span className="text-on-surface-variant">({detail.order.shipTo.countryCode})</span>}
                    {detail.order.shipTo.place && <span className="text-on-surface-variant">· {detail.order.shipTo.place}</span>}</>
                  : <span className="text-on-surface-variant">chưa có địa chỉ giao</span>}
              </Fact>
              <Fact icon="folder" label="Thư mục Drive">
                <DriveFolderLink folderUrl={detail.driveFolder?.url} driveConnected={detail.driveConnected} onCopied={setInfo} compact />
              </Fact>
              <Fact icon="event" label="Ngày đặt">{fmtDate(task.placedAt)}</Fact>
              <Fact icon="schedule" label="Hạn">
                {task.dueAt ? fmtDateTime(task.dueAt) : 'chưa đặt hạn'}
                <Pill tone={left.tone} icon={left.icon}>{left.label}</Pill>
                <span className="text-on-surface-variant">· SLA {task.slaHours}h</span>
              </Fact>
              <Fact icon="auto_awesome" label="Nguồn">{sourceEngine(line)}</Fact>
              <Fact icon="sticky_note_2" label="Ghi chú CS">
                <CsNote detail={detail} lastAsk={task.status === 'ASK_CUSTOMER' && lastAsk ? lastAsk.message : null} onChanged={onChanged} />
              </Fact>
              {(detail.order.addOns?.length ?? 0) > 0 && (
                <Fact icon="add_circle" label="Add-on của đơn">
                  <ul className="flex flex-col gap-[2px] min-w-0">
                    {detail.order.addOns!.map((a, i) => (
                      <li key={`${a.title}-${i}`} className="break-words">
                        <b>{a.title}</b>{a.variantTitle ? ` [${a.variantTitle}]` : ''} <span className="text-on-surface-variant">x{a.qty}</span>
                        {a.details && <span> — {a.details}</span>}
                      </li>
                    ))}
                  </ul>
                </Fact>
              )}
              <Fact icon="inventory_2" label="Sản phẩm">
                {detail.profileRouteKey
                  ? <Link href={productPageUrl(detail.profileRouteKey)} className="text-secondary hover:underline">Mở trang sản phẩm (mapping · artwork)</Link>
                  : <span className="text-on-surface-variant">dòng không gắn sản phẩm Shopify</span>}
                {detail.library?.optionLabel && <span className="text-on-surface-variant">· artwork {detail.library.optionLabel}</span>}
              </Fact>
            </dl>
            <div className="flex flex-col gap-xs">
              <b className="text-label-sm text-on-surface">Khách nhập</b>
              <CustomTable detail={detail} onCopied={setInfo} />
            </div>
          </div>
        </section>

        <section aria-labelledby="ds-todo-title" className="min-w-0 rounded-xl shadow-card border border-secondary/30 bg-secondary/5">
          <div className={`${blockHead} border-secondary/20 text-secondary`}>
            <Icon name="checklist" className="text-[18px]" />
            <span id="ds-todo-title">CẦN LÀM</span>
            <span className="ml-auto normal-case tracking-normal font-semibold">{checklist.done}/{checklist.total} xong</span>
          </div>
          <input ref={uploadInput} type="file" accept={ARTWORK_ACCEPT} hidden aria-label="Chọn file cho việc đang thiếu"
            onChange={e => {
              const files = Array.from(e.target.files ?? [])
              const { area, kind } = uploadTarget.current
              e.target.value = ''
              if (files.length === 0) return
              if (area) up.upload(area, files[0], kind)
              else up.uploadFiles(files, { kind })
            }} />
          <ol className="px-sm py-sm flex flex-col gap-xs">
            {checklist.items.map((item, i) => {
              const meta = STATE_META[item.state]
              const isNext = item === checklist.next
              return (
                <li key={item.key} aria-current={isNext ? 'step' : undefined}
                  className={`flex items-start gap-sm rounded-lg px-sm py-xs ${isNext ? 'bg-surface-container-lowest ring-2 ring-secondary shadow-card' : ''} ${item.state === 'na' ? 'opacity-60' : ''}`}>
                  <span className={`mt-[1px] ${meta.cls}`} title={meta.label}>
                    <Icon name={meta.icon} className="text-[20px]" /><span className="sr-only">{meta.label}</span>
                  </span>
                  <span className="flex-1 min-w-0 flex flex-col">
                    {isNext && (
                      <span className="inline-flex items-center gap-xs self-start rounded-md bg-secondary text-on-secondary px-xs text-label-sm font-semibold mb-[2px]">
                        <Icon name="arrow_forward" className="text-[13px]" />Việc cần làm tiếp
                      </span>
                    )}
                    <span className={`text-body-sm ${isNext ? 'font-bold' : 'font-semibold'} text-on-surface`}>{i + 1}. {item.title}</span>
                    <span className="text-label-sm text-on-surface-variant">{item.reason}</span>
                  </span>
                  {checkAction(item)}
                </li>
              )
            })}
          </ol>
          {up.error && <div className="px-sm pb-sm"><ErrorBanner msg={up.error} onClose={() => up.setError('')} /></div>}
        </section>
      </div>

      <section aria-labelledby="ds-assign-title" className={`${card} px-md py-sm flex flex-col gap-sm`}>
        <div className="flex items-center gap-sm flex-wrap text-body-sm">
          <span className="flex items-center gap-xs text-label-sm font-bold uppercase tracking-wider text-on-surface-variant">
            <Icon name="assignment_ind" className="text-[18px]" /><span id="ds-assign-title">GIAO VIỆC</span>
          </span>
          <span className="inline-flex items-center gap-xs"><Icon name="person" className="text-[16px] text-on-surface-variant" />{task.assigneeName ? <b>{task.assigneeName}</b> : <span className="text-on-surface-variant">chưa giao</span>}</span>
          <span className="inline-flex items-center gap-xs"><Icon name="military_tech" className="text-[16px] text-on-surface-variant" />KPI <b>{task.kpi}</b></span>
          {!can('ASSIGNED') && <span className="text-label-sm text-on-surface-variant">Leader giao việc và đặt KPI / hạn</span>}
        </div>
        {can('ASSIGNED') && (
          <form onSubmit={submitAssign} className="flex flex-wrap items-end gap-sm">
            <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">Giao cho
              <select value={assignee} onChange={e => setAssignee(e.target.value)} className={input}>
                {detail.assignable.length === 0 && <option value="">— không có người —</option>}
                {detail.assignable.map(u => <option key={u.id} value={u.id}>{u.name} · đang giữ {holdCount[u.id] ?? 0}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">Điểm KPI
              <input type="number" step="0.05" min="0" value={kpi} onChange={e => setKpi(e.target.value)} className={`${input} w-20`} />
            </label>
            <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant">Hạn (giờ)
              <input type="number" min="1" value={dueHours} onChange={e => setDueHours(e.target.value)} className={`${input} w-20`} />
            </label>
            <label className="flex flex-col gap-[2px] text-label-sm text-on-surface-variant flex-1 min-w-[160px]">Yêu cầu
              <input value={assignNote} onChange={e => setAssignNote(e.target.value)} placeholder="vd: dựng lại từ master" className={`${input} w-full`} />
            </label>
            <button type="submit" className={btn} disabled={busy || !assignee}><Icon name="person_add" className="text-[18px]" />{task.assigneeId ? 'Giao lại' : 'Giao việc'}</button>
          </form>
        )}
      </section>
    </div>
  )
}
