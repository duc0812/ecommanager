'use client'
import { useState, type ReactNode } from 'react'
import type { SentLineRow, TaskRow } from './types'
import { STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import { LINE_FIX_HELP, type LineFix } from '@/lib/line-fix'
import { lineReopenUrl, postJson } from './model'
import { useToast } from './overlay'
import LineFixForm from './LineFixForm'
import { Card, ExtLink, Icon, Pill, btnPrimaryMd, card, fmtDate } from './ui'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-sm text-body-sm">
      <span className="w-[120px] shrink-0 text-on-surface-variant">{label}</span>
      <span className="flex-1 min-w-0 text-on-surface break-words">{children}</span>
    </div>
  )
}

/** What went to the supplier for a sent line that never had a design task, and the button that reopens it for a fix. */
export default function SentLinePanel({ line, onReopened }: { line: SentLineRow; onReopened: (taskKey: string) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const image = line.previewUrl ?? line.imageUrl
  const status = STATUS_LABELS[line.pipelineStatus as PipelineStatus] ?? line.pipelineStatus

  async function reopen(fix: LineFix) {
    if (busy) return
    setBusy(true)
    const r = await postJson<{ task: TaskRow; changed: boolean }>(lineReopenUrl(line.lineId), fix)
    setBusy(false)
    if (!r.ok) { toast.say(r.error, 'bad'); return }
    toast.say(r.data.changed ? `Đã mở lại ${r.data.task.taskKey} để sửa` : `${r.data.task.taskKey} đang mở sẵn`)
    onReopened(r.data.task.taskKey)
  }
  return (
    <div className="flex flex-col gap-md min-w-0">
      <section aria-label={`Dòng ${line.lineKey}`} className={`${card} px-[20px] py-md flex flex-col gap-sm`}>
        <div className="flex flex-wrap items-center gap-sm">
          <h2 className="font-mono text-[22px] leading-7 font-bold tracking-tight text-on-surface">{line.lineKey}</h2>
          <Pill tone="ok" icon="local_shipping" size="md">Đã gửi xưởng{line.sentAt ? ` ${fmtDate(line.sentAt)}` : ''}</Pill>
          <Pill tone="idle" icon="assignment_late" size="md">Chưa có task design</Pill>
        </div>
        <div className="flex flex-wrap items-center gap-x-md gap-y-xs text-body-sm text-on-surface-variant">
          <span className="font-semibold text-on-surface">{line.productTitle}</span>
          {line.variantTitle && <span>Biến thể <b className="text-on-surface">{line.variantTitle}</b></span>}
          <span>SL <b className="text-on-surface">{line.qty}</b></span>
          <span>Đơn <span className="font-mono text-on-surface">{line.orderNumber}</span> · đặt {fmtDate(line.placedAt)}</span>
          <span>Store {line.storeName}</span>
        </div>
        {asking ? (
          <div className="max-w-[560px] rounded-lg border border-outline-variant/40 bg-surface-container-low p-md">
            <LineFixForm busy={busy} onSubmit={reopen} onCancel={() => setAsking(false)} />
          </div>
        ) : (
          <div className="flex flex-col items-start gap-xs pt-xs">
            <button type="button" className={btnPrimaryMd} onClick={() => setAsking(true)}>
              <Icon name="edit" className="text-[18px]" />Mở lại để sửa
            </button>
            <span className="text-label-sm text-on-surface-variant">{LINE_FIX_HELP}</span>
          </div>
        )}
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-md items-start">
        <Card icon="inventory_2" title="Dòng hàng">
          <Row label="SKU">{line.sku ? <span className="font-mono">{line.sku}</span> : '—'}</Row>
          <Row label="Xưởng">{line.supplierName ?? '—'}</Row>
          <Row label="Trạng thái đơn">{status}</Row>
          <Row label="Ngày gửi xưởng">{line.sentAt ? fmtDate(line.sentAt) : '—'}</Row>
        </Card>
        <Card icon="edit_note" title="Thông tin khách nhập" right={line.personalization.length || undefined}>
          {line.personalization.length === 0
            ? <span className="text-body-sm text-on-surface-variant">Khách không nhập gì</span>
            : line.personalization.map((p, i) => <Row key={`${p.key}-${i}`} label={p.key}>{p.value}</Row>)}
        </Card>
        <Card icon="link" title="File đã gửi xưởng">
          {line.designLinks.length === 0 && line.sourcePrintFiles.length === 0 && (
            <span className="text-body-sm text-on-surface-variant">Dòng không lưu link design</span>
          )}
          {line.designLinks.map(href => (
            <span key={href} className="flex items-center gap-xs text-body-sm min-w-0">
              <Icon name="open_in_new" className="text-[16px] text-on-surface-variant" />
              <span className="truncate"><ExtLink href={href}>{href}</ExtLink></span>
            </span>
          ))}
          {line.sourcePrintFiles.map(f => (
            <span key={`${f.printArea}-${f.url}`} className="flex items-center gap-xs text-body-sm min-w-0">
              <Icon name="attach_file" className="text-[16px] text-on-surface-variant" />
              <span className="truncate"><ExtLink href={f.url}>_print_files · {f.printArea}</ExtLink></span>
            </span>
          ))}
        </Card>
        {image && (
          <Card icon="image" title="Ảnh xem trước">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <a href={image} target="_blank" rel="noreferrer"><img src={image} alt={`Ảnh xem trước ${line.lineKey}`} className="max-h-[320px] rounded-lg object-contain" /></a>
          </Card>
        )}
      </div>
    </div>
  )
}
