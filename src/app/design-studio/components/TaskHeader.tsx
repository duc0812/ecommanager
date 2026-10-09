'use client'
import { useState, type FormEvent } from 'react'
import type { TaskDetail, TransitionBody } from './types'
import { OWNED_MOVES, allSlotsFilled, canTransition, layerOf, postJson, sourceEngine, taskUrl, timeLeft } from './model'
import { ErrorBanner, Icon, Pill, READY_META, STATUS_META, btn, btnPrimary, btnWarn, card, input } from './ui'

function hasNonAscii(s: string) { return /[^\x00-\x7F]/.test(s) }

function CustomTable({ detail, onCopied }: { detail: TaskDetail; onCopied: (msg: string) => void }) {
  const { line } = detail
  async function copy(v: string) {
    try { await navigator.clipboard.writeText(v); onCopied(`Đã chép "${v}"`) } catch { onCopied('Không chép được') }
  }
  if (!line.attributesLoaded) {
    return <div className="px-sm text-body-sm text-on-surface-variant">Chưa có dữ liệu custom cho dòng này — bấm &quot;Nạp lại từ Shopify&quot;.</div>
  }
  if (line.personalization.length === 0) {
    return (
      <div className="px-sm text-body-sm text-on-surface-variant">
        {line.customized ? 'Khách không nhập gì.' : 'Non-custom: 1 design cho SKU × xưởng.'}
        {line.variantTitle && ` Biến thể: ${line.variantTitle}`}
      </div>
    )
  }
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
          <th className="px-sm py-xs font-medium w-8">#</th>
          <th className="px-sm py-xs font-medium">Trường</th>
          <th className="px-sm py-xs font-medium">Giá trị khách nhập</th>
          <th className="px-sm py-xs font-medium">Layer</th>
          <th className="px-sm py-xs font-medium">Biến thể</th>
        </tr>
      </thead>
      <tbody>
        {line.personalization.map((f, i) => (
          <tr key={`${f.key}-${i}`} className="border-b border-outline-variant/20 last:border-b-0">
            <td className="px-sm py-xs text-on-surface-variant">{i + 1}</td>
            <td className="px-sm py-xs">{f.key}</td>
            <td className="px-sm py-xs">
              <span className="flex items-center gap-xs flex-wrap">
                <span className="font-mono font-semibold break-all">{f.value}</span>
                <button type="button" onClick={() => copy(f.value)} aria-label={`Chép ${f.key}`} title="Chép" className="text-on-surface-variant hover:text-secondary leading-none">
                  <Icon name="content_copy" className="text-[15px]" />
                </button>
                {hasNonAscii(f.value) && <Pill tone="bad">ký tự đặc biệt</Pill>}
                {f.value.length > 14 && <Pill tone="warn">{f.value.length} ký tự</Pill>}
              </span>
            </td>
            <td className="px-sm py-xs font-mono text-label-sm text-secondary">{layerOf(f.key)}</td>
            <td className="px-sm py-xs text-on-surface-variant">{i === 0 ? (line.variantTitle ?? '—') : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

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
  const [remember, setRemember] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const owns = me.isLeader || !task.assigneeId || task.assigneeId === me.id
  const can = (to: TransitionBody['to']) => canTransition(task.status, to, me.isLeader, task.readiness) && (owns || !OWNED_MOVES.includes(to))
  const filled = allSlotsFilled(detail)
  const ready = READY_META[task.readiness]
  const status = STATUS_META[task.status]
  const left = timeLeft(task)

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

  function cancelTask() {
    if (!window.confirm(`Huỷ task ${task.taskKey}?`)) return
    go({ to: 'CANCELLED' })
  }

  const filesTitle = filled ? undefined : 'Upload đủ file cho mọi panel trước'
  const actions: JSX.Element[] = []
  if (task.status === 'ASK_CUSTOMER' && (owns || !OWNED_MOVES.includes(detail.prevStatus ?? 'NEW'))) {
    actions.push(<button key="continue" type="button" className={btnPrimary} disabled={busy} onClick={() => go({ to: detail.prevStatus ?? 'NEW', continue: true })}><Icon name="play_arrow" className="text-[18px]" />Tiếp tục</button>)
  }
  if (can('ASK_CUSTOMER')) {
    actions.push(<button key="ask" type="button" className={btnWarn} disabled={busy} aria-expanded={panel === 'ask'} onClick={() => setPanel(panel === 'ask' ? 'none' : 'ask')}><Icon name="contact_support" className="text-[18px]" />Hỏi khách</button>)
  }
  if (can('NEW') && (!me.isLeader || task.assigneeId === me.id)) {
    actions.push(<button key="deny" type="button" className={btn} disabled={busy} onClick={() => go({ to: 'NEW' })}><Icon name="block" className="text-[18px]" />Từ chối</button>)
  }
  if (can('DOING') && (task.status === 'NEW' || task.status === 'ASSIGNED')) {
    actions.push(<button key="take" type="button" className={btn} disabled={busy} onClick={() => go({ to: 'DOING' })}><Icon name="front_hand" className="text-[18px]" />Nhận việc</button>)
  }
  if (can('REVIEW')) {
    actions.push(<button key="submit" type="button" className={btnPrimary} disabled={busy || !filled} title={filesTitle} onClick={() => go({ to: 'REVIEW' })}><Icon name="rate_review" className="text-[18px]" />Gửi duyệt</button>)
  }
  if (can('REJECTED')) {
    actions.push(<button key="reject" type="button" className={btnWarn} disabled={busy} aria-expanded={panel === 'reject'} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setReasons([]) }}><Icon name="undo" className="text-[18px]" />Trả lại sửa</button>)
  }
  if (can('DONE')) {
    actions.push(<button key="done" type="button" className={btnPrimary} disabled={busy || !filled} title={filesTitle} onClick={() => go({ to: 'DONE' })}><Icon name="send" className="text-[18px]" />{me.isLeader ? 'Duyệt & gửi xưởng' : 'Duyệt nhanh & gửi xưởng'}</button>)
  } else if (task.status === 'REVIEW' && !me.isLeader) {
    actions.push(<button key="wait" type="button" className={btnPrimary} disabled><Icon name="hourglass_top" className="text-[18px]" />Chờ leader duyệt</button>)
  }
  if (task.status === 'DONE' && can('DOING')) {
    actions.push(<button key="reopen" type="button" className={btn} disabled={busy} onClick={() => go({ to: 'DOING' })}><Icon name="edit" className="text-[18px]" />Sửa & gửi lại</button>)
  }
  if (can('CANCELLED')) {
    actions.push(<button key="cancel" type="button" className={btn} disabled={busy} onClick={cancelTask}><Icon name="cancel" className="text-[18px]" />Huỷ task</button>)
  }

  return (
    <div className={`${card} px-md py-sm flex flex-col gap-sm`}>
      <div className="flex items-center gap-sm flex-wrap">
        <h2 className="font-mono text-headline-sm text-on-surface">{task.taskKey}</h2>
        <Pill tone={status.tone}>{status.label}</Pill>
        <Pill tone={ready.tone} icon={ready.icon}>{ready.label}</Pill>
        <Pill tone={left.tone} icon={left.icon}>{left.label}</Pill>
        <span className="flex-1 min-w-[200px] text-body-sm text-on-surface-variant">{task.productTitle}</span>
      </div>

      <div className="flex flex-wrap gap-x-md gap-y-xs text-label-sm text-on-surface-variant">
        <span className="inline-flex items-center gap-xs"><Icon name="receipt_long" className="text-[16px]" />Đơn <b className="text-on-surface">{task.orderNumber}</b> · dòng {task.linePosition}</span>
        <span className="inline-flex items-center gap-xs"><Icon name="storefront" className="text-[16px]" /><b className="text-on-surface">{task.storeName}</b></span>
        <span className="inline-flex items-center gap-xs"><Icon name="sell" className="text-[16px]" />SKU <b className="text-on-surface">{task.sku ?? '—'}</b></span>
        <span className="inline-flex items-center gap-xs"><Icon name="factory" className="text-[16px]" /><b className="text-on-surface">{line.supplier?.name ?? task.supplierName ?? '—'}</b></span>
        <span className="inline-flex items-center gap-xs"><Icon name="military_tech" className="text-[16px]" />KPI <b className="text-on-surface">{task.kpi}</b></span>
        <span className="inline-flex items-center gap-xs"><Icon name="person" className="text-[16px]" />{task.assigneeName ? <b className="text-on-surface">{task.assigneeName}</b> : 'chưa giao'}</span>
        <span className="inline-flex items-center gap-xs"><Icon name="auto_awesome" className="text-[16px]" />{sourceEngine(line)}</span>
        <span className="inline-flex items-center gap-xs"><Icon name="event" className="text-[16px]" />{new Date(task.placedAt).toLocaleDateString('en-US')}</span>
        <button type="button" onClick={refreshFromShopify} disabled={refreshing} className={btn}>
          <Icon name="sync" className="text-[16px]" />{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}
        </button>
      </div>

      <CustomTable detail={detail} onCopied={setInfo} />

      <div className="flex items-center gap-xs flex-wrap justify-end pt-xs border-t border-dashed border-outline-variant/40">
        {line.sourcePrintFiles.length > 0 && (
          <label className="mr-auto inline-flex items-center gap-xs text-label-sm text-on-surface-variant">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="accent-secondary" />
            Nhớ cách gắn dữ liệu → layer cho <b className="text-on-surface">{task.sku ?? '—'}</b>
          </label>
        )}
        {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
        {actions}
      </div>

      <ErrorBanner msg={error} onClose={() => setError('')} />

      {can('ASSIGNED') && (
        <form onSubmit={submitAssign} className="flex flex-wrap items-end gap-sm p-sm rounded-lg bg-surface-container-low border border-outline-variant/20">
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
          <input value={askNote} onChange={e => setAskNote(e.target.value)} placeholder="Cần hỏi khách điều gì?" aria-label="Nội dung hỏi khách" className={`${input} flex-1`} />
          <button type="submit" className={btnWarn} disabled={busy || !askNote.trim()}><Icon name="contact_support" className="text-[18px]" />Chuyển CS hỏi khách</button>
        </form>
      )}
    </div>
  )
}
