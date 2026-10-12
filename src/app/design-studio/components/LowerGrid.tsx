'use client'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { ArtworkRow, TaskDetail, TemplateRow, TransitionBody } from './types'
import { allSlotsFilled, canMove, newestArtwork, postJson, sharpnessRatio, sourceEngine, targetFor, taskUrl, type Tone } from './model'
import ArtworkSlots from './ArtworkSlots'
import AutoRenderBar from './AutoRenderBar'
import { Avatar, Card, ErrorBanner, ExtLink, Icon, TEXT_TONE, btn, btnPrimary, input } from './ui'

const STATUS_ICON: Record<Tone, string> = { ok: 'check_circle', warn: 'error', bad: 'cancel', idle: 'remove', brand: 'info' }

function Mark({ tone }: { tone: Tone }) {
  const label = tone === 'ok' ? 'đạt' : tone === 'warn' ? 'cần xem' : tone === 'bad' ? 'không đạt' : 'chưa có'
  return <span title={label} aria-label={label} className={TEXT_TONE[tone]}><Icon name={STATUS_ICON[tone]} className="text-[16px]" /></span>
}

function SupplierCard({ detail }: { detail: TaskDetail }) {
  const { line, template } = detail
  const tplLink = template?.templateUrl ?? line.templateUrl
  const row = (dt: string, dd: ReactNode) => (
    <>
      <dt className="text-on-surface-variant">{dt}</dt>
      <dd className="min-w-0 break-words">{dd}</dd>
    </>
  )
  return (
    <Card icon="dashboard_customize" title="Xưởng & template">
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-sm gap-y-xs text-body-sm">
        {row('Xưởng', line.supplier ? <b>{line.supplier.name} <span className="font-normal text-on-surface-variant">({line.supplier.code})</span></b> : <span className="text-error">chưa map</span>)}
        {row('SKU xưởng', line.supplierSku ?? '—')}
        {row('Template', template
          ? <span className="flex flex-col">
              {tplLink ? <ExtLink href={tplLink}>{template.name} ↗</ExtLink> : <span>{template.name}</span>}
              <span className="text-label-sm text-on-surface-variant">{template.widthPx}×{template.heightPx} · {template.dpi} DPI · {template.areas.length} panel</span>
            </span>
          : tplLink ? <ExtLink href={tplLink}>Mở template ↗</ExtLink> : <span className="text-amber-900">chưa có template cho SKU</span>)}
        {row('Master artwork', line.masterArtworkUrl ? <ExtLink href={line.masterArtworkUrl}>Mở master ↗</ExtLink> : '—')}
        {row('Design Library', line.libraryDesignLink ? <ExtLink href={line.libraryDesignLink}>Có design sẵn ↗</ExtLink> : line.designStatus)}
        {row('Link khách', (line.customerDesignLink || line.customizedUrl || line.sourcePrintFiles.length > 0)
          ? <span className="flex flex-wrap gap-x-sm">
              {line.customerDesignLink && <ExtLink href={line.customerDesignLink}>Mở lại thiết kế ↗</ExtLink>}
              {line.customizedUrl && <ExtLink href={line.customizedUrl}>Customized URL ↗</ExtLink>}
              {line.sourcePrintFiles.map(f => <ExtLink key={f.url} href={f.url}>_print_files · {f.printArea} ↗</ExtLink>)}
            </span>
          : '—')}
        {row('Nguồn', sourceEngine(line))}
      </dl>
    </Card>
  )
}

function ReqTable({ template, art }: { template: TemplateRow | null; art: ArtworkRow | undefined }) {
  if (!template) {
    return (
      <Card icon="rule" title="Yêu cầu xưởng ↔ file">
        <div className="text-body-sm text-on-surface-variant">Chưa có template — không so được yêu cầu xưởng.</div>
      </Card>
    )
  }
  const target = targetFor(template, art?.printArea)
  const hasPx = !!(art?.widthPx && art?.heightPx)
  const ratio = sharpnessRatio(template, art)
  const sizeTone: Tone = !art ? 'bad' : !hasPx ? 'idle'
    : (art.widthPx === target.w && art.heightPx === target.h) || (art.widthPx === template.widthPx && art.heightPx === template.heightPx) ? 'ok' : 'warn'
  const sharpTone: Tone = ratio === null ? (art ? 'idle' : 'bad') : ratio >= 0.95 ? 'ok' : ratio >= 0.5 ? 'warn' : 'bad'
  const isRaster = art?.mimeType === 'image/png' || art?.mimeType === 'image/jpeg'
  const formatTone: Tone = !art ? 'bad' : isRaster ? 'ok' : 'warn'
  const bleedPx = Math.round(template.bleedIn * template.dpi)
  const bleedTone: Tone = ratio === null ? (art ? 'idle' : 'bad') : ratio >= 1 ? 'ok' : 'warn'
  const rows: { item: string; need: string; have: string; tone: Tone }[] = [
    { item: 'Khổ template', need: `${template.widthPx}×${template.heightPx}${target.area ? ` (${target.area.name} ${target.w}×${target.h})` : ''}`, have: art ? (hasPx ? `${art.widthPx}×${art.heightPx}` : 'chưa đọc được px') : 'chưa có file', tone: sizeTone },
    { item: 'Độ nét', need: `${template.dpi} DPI`, have: ratio === null ? (art ? '—' : 'chưa có file') : `~${Math.round(template.dpi * ratio)} DPI (${Math.round(ratio * 100)}%)`, tone: sharpTone },
    { item: 'Định dạng', need: 'PNG/JPG', have: art ? art.mimeType.replace(/^[a-z]+\//, '').toUpperCase() : 'chưa có file', tone: formatTone },
    { item: 'Bleed', need: `${template.bleedIn}″ = ${bleedPx} px mỗi cạnh`, have: ratio === null ? (art ? 'kiểm trên canvas' : 'chưa có file') : ratio >= 1 ? 'file phủ đủ panel' : 'file nhỏ hơn panel', tone: bleedTone },
  ]
  return (
    <Card icon="rule" title="Yêu cầu xưởng ↔ file" right={art ? `${art.printArea} · v${art.version}` : undefined}>
      <table className="w-full border-collapse text-label-sm">
        <thead>
          <tr className="text-on-surface-variant text-left border-b border-outline-variant/20">
            <th className="px-xs py-xs font-medium">Mục</th>
            <th className="px-xs py-xs font-medium">Xưởng yêu cầu</th>
            <th className="px-xs py-xs font-medium">File hiện tại</th>
            <th className="px-xs py-xs font-medium"><span className="sr-only">Kết quả</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.item} className="border-b border-outline-variant/20 last:border-b-0">
              <td className="px-xs py-xs">{r.item}</td>
              <td className="px-xs py-xs font-mono">{r.need}</td>
              <td className="px-xs py-xs font-mono">{r.have}</td>
              <td className="px-xs py-xs"><Mark tone={r.tone} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

const CHECKS = [
  'Nội dung in khớp đơn (chính tả, hoa/thường, ký tự đặc biệt)',
  'Chữ và hình quan trọng nằm trong vùng an toàn',
  'Độ nét đạt ngưỡng xưởng ở kích thước in',
  'Đúng màu / biến thể khách chọn',
  'Đủ file cho mọi panel của template',
]

function Checklist({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { task, line, template } = detail
  const [manual, setManual] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filled = allSlotsFilled(detail)
  const ratio = template ? sharpnessRatio(template, newestArtwork(line)) : null
  const auto: boolean[] = [false, false, ratio !== null && ratio >= 0.95, false, filled]
  const checked = CHECKS.map((_, i) => manual[i] ?? auto[i])
  const done = checked.filter(Boolean).length
  const can = (to: TransitionBody['to']) => canMove(detail, to)

  let action: { to: TransitionBody['to']; label: string; icon: string } | null = null
  if (can('DONE')) action = { to: 'DONE', label: 'Duyệt design', icon: 'verified' }
  else if (can('REVIEW')) action = { to: 'REVIEW', label: 'Gửi duyệt', icon: 'rate_review' }

  async function run() {
    if (!action || busy) return
    setBusy(true); setError('')
    const r = await postJson(taskUrl(task.taskKey, '/transition'), { to: action.to })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    onChanged()
  }

  return (
    <Card icon="fact_check" title="Tự kiểm file trước khi gửi" right={`${done}/${CHECKS.length}`}>
      <div className="flex flex-col">
        {CHECKS.map((c, i) => (
          <label key={c} className="flex items-start gap-sm px-xs py-xs rounded-md text-body-sm cursor-pointer hover:bg-surface-container-low">
            <input type="checkbox" checked={checked[i]} onChange={e => setManual({ ...manual, [i]: e.target.checked })} className="mt-[3px] accent-secondary" />
            <span className="flex-1">{c}</span>
            {auto[i] && <span className="text-label-sm text-tertiary whitespace-nowrap">máy đã kiểm</span>}
          </label>
        ))}
      </div>
      <ErrorBanner msg={error} onClose={() => setError('')} />
      {task.status === 'DONE'
        ? <button type="button" disabled className={`${btnPrimary} w-full justify-center`}><Icon name="verified" className="text-[18px]" />Đã duyệt design</button>
        : <button type="button" onClick={run} disabled={!action || busy || !filled || !checked.every(Boolean)}
            title={!action ? 'Không có bước tiếp theo cho vai trò này' : !filled ? 'Upload đủ file cho mọi panel trước' : !checked.every(Boolean) ? 'Tick đủ checklist trước' : undefined}
            className={`${btnPrimary} w-full justify-center`}>
            <Icon name={action?.icon ?? 'verified'} className="text-[18px]" />{action?.label ?? 'Duyệt design'}
          </button>}
    </Card>
  )
}

function Feed({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function send(e: FormEvent) {
    e.preventDefault()
    const message = msg.trim()
    if (!message || busy) return
    setBusy(true); setError('')
    const r = await postJson(taskUrl(detail.task.taskKey, '/events'), { message })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setMsg('')
    onChanged()
  }

  return (
    <Card icon="forum" title="Trao đổi & lịch sử" right={`${detail.events.length}`}>
      <div className="flex flex-col gap-sm">
        {detail.events.map(ev => {
          const system = ev.type === 'SYSTEM' || !ev.actorName
          return (
            <div key={ev.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-sm text-body-sm">
              {system
                ? <span className="w-6 h-6 rounded-full bg-surface-container-low grid place-items-center text-on-surface-variant"><Icon name="smart_toy" className="text-[15px]" /></span>
                : <Avatar name={ev.actorName!} size="md" />}
              <span className="min-w-0">
                <span className="font-semibold">{system ? 'Hệ thống' : ev.actorName}</span>
                <span className="ml-sm text-label-sm text-on-surface-variant">{new Date(ev.createdAt).toLocaleString('en-US')}</span>
                <span className="block break-words">{ev.message}</span>
              </span>
            </div>
          )
        })}
        {detail.events.length === 0 && <div className="text-label-sm text-on-surface-variant">Chưa có hoạt động</div>}
      </div>
      <ErrorBanner msg={error} onClose={() => setError('')} />
      <form onSubmit={send} className="flex gap-xs">
        <input value={msg} onChange={e => setMsg(e.target.value)} placeholder="Ghi chú / @CS hỏi khách…" aria-label="Ghi chú mới" autoComplete="off" className={`${input} flex-1`} />
        <button type="submit" className={btn} disabled={busy || !msg.trim()} aria-label="Gửi ghi chú"><Icon name="send" className="text-[18px]" /></button>
      </form>
    </Card>
  )
}

export default function LowerGrid({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const art = newestArtwork(detail.line)
  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-md items-start">
      <div className="flex flex-col gap-md min-w-0">
        <ArtworkSlots line={detail.line} slots={detail.slots} driveConnected={detail.driveConnected} onUploaded={onChanged} me={detail.me} taskStatus={detail.task.status}
          autoRender={<AutoRenderBar detail={detail} onChanged={onChanged} />} />
        <SupplierCard detail={detail} />
      </div>
      <div className="flex flex-col gap-md min-w-0">
        <ReqTable template={detail.template} art={art} />
        <Checklist detail={detail} onChanged={onChanged} />
        <Feed detail={detail} onChanged={onChanged} />
      </div>
    </div>
  )
}
