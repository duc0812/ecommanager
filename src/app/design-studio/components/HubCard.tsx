'use client'
import type { HandoffCard, Me } from './types'
import { mockupFiles } from './model'
import { ArtImg } from './art-src'
import HandoffButton from './HandoffButton'
import { Icon, Pill, btnPrimary, card as cardClass } from './ui'
import { HUB_WARNING_LABELS, fmtUsd, hubTypeLabel, hubView } from '@/lib/handoff-hub'

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })

/** One order at one supplier, always the same height: the details live in the task it opens. */
export default function HubCard({ c, tabId, sheet, me, onOpenTask, onSheet, onChanged, onError }: {
  c: HandoffCard; tabId: string
  /** This tab's supplier takes orders through its sheet. */
  sheet: boolean
  me: Me | null; onOpenTask: (key: string) => void; onSheet: (orderId: string) => void; onChanged: (info: string) => void; onError: (msg: string) => void
}) {
  const view = hubView(c, tabId)
  const first = view.first
  if (!first) return null
  const { order, state } = c
  const line = first.line
  const mockup = mockupFiles(line)[0]
  const photo = line.previewUrl ?? line.imageUrl
  const warnText = view.warnings.map(w => `${w.taskKey}: ${HUB_WARNING_LABELS[w.code]}`).join(' · ')
  const printed = line.personalization.map(p => p.value).filter(Boolean).join(', ')
  const empty = <span className="w-full h-full grid place-items-center text-on-surface-variant"><Icon name="image" className="text-[24px]" /></span>
  // eslint-disable-next-line @next/next/no-img-element
  const shown = photo ? <img src={photo} alt="" loading="lazy" className="w-full h-full object-cover" /> : empty

  return (
    <article aria-label={`Đơn ${order.orderNumber}`} onClick={() => onOpenTask(first.taskKey)}
      className={`${cardClass} h-[172px] p-sm flex flex-col gap-xs cursor-pointer hover:border-secondary/50 overflow-hidden ${view.warnings.length ? 'ring-1 ring-error/60' : ''}`}>
      <div className="flex gap-sm flex-1 min-h-0">
        <div className="w-[88px] h-[88px] shrink-0 rounded-lg overflow-hidden border border-outline-variant/30 bg-surface-container-low">
          {mockup ? <ArtImg art={mockup} px={240} alt="" loading="lazy" className="w-full h-full object-cover" fallback={shown} /> : shown}
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-[2px] text-label-sm text-on-surface-variant">
          <span className="flex items-center gap-xs min-w-0">
            <button type="button" onClick={e => { e.stopPropagation(); onOpenTask(first.taskKey) }} title="Mở task"
              className="font-mono font-semibold text-body-sm text-secondary hover:underline truncate">{first.taskKey}</button>
            {view.mixed && <Pill tone="idle" icon="call_split">Nhiều xưởng</Pill>}
            <span className="ml-auto shrink-0 font-semibold text-on-surface" title={order.countryName ?? order.country ?? undefined}>{order.countryCode ?? order.country ?? '—'}</span>
            {view.warnings.length > 0 && <span role="img" aria-label={`Cảnh báo: ${warnText}`} title={warnText} className="shrink-0 leading-none"><Icon name="warning" className="text-[16px] text-error" /></span>}
          </span>
          <span className="truncate text-body-sm font-semibold text-on-surface" title={line.productTitle}>{line.productTitle}</span>
          <span className="truncate" title={hubTypeLabel(first)}>{hubTypeLabel(first) || '—'}</span>
          <span className="truncate">{line.variantTitle ? `${line.variantTitle} · ` : ''}SL {line.qty}</span>
          {printed && <span className="truncate" title={printed}>Custom: <b className="text-on-surface">{printed}</b></span>}
        </div>
      </div>
      <div className="flex items-center gap-sm text-label-sm text-on-surface-variant min-w-0" onClick={e => e.stopPropagation()}>
        <span className="min-w-0 truncate">
          {view.costMissing && view.baseCost === 0
            ? <b className="text-amber-900">Chưa có giá</b>
            : <b className="text-on-surface" title={view.costMissing ? 'Có dòng chưa có giá, chưa tính vào tổng' : 'Base cost, chưa gồm phí ship'}>{fmtUsd(view.baseCost)}{view.costMissing ? '+' : ''}</b>}
          {' · '}{fmtDate(order.placedAt)}{view.extra > 0 ? ` · +${view.extra} dòng` : ''}
        </span>
        <span className="ml-auto shrink-0 flex items-center gap-xs">
          {sheet ? (
            <button type="button" className={btnPrimary} disabled={!me?.canHandoff || view.warnings.length > 0} onClick={() => onSheet(order.id)}
              title={view.warnings.length ? `Sửa cảnh báo trước: ${warnText}` : 'Ghi đơn vào sheet của xưởng'}>
              <Icon name="table_view" className="text-[16px]" />Sản xuất
            </button>
          ) : <HandoffButton compact orderId={order.id} state={state} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} />}
        </span>
      </div>
    </article>
  )
}
