'use client'
import Link from 'next/link'
import type { CheckItem, Checklist } from './checklist'
import { Icon } from './ui'

function dot(item: CheckItem, isNext: boolean): string {
  const base = 'inline-block w-3 h-3 rounded-full shrink-0'
  if (isNext) return `${base} border-2 border-secondary ring-4 ring-secondary/20 bg-surface-container-lowest`
  if (item.state === 'done') return `${base} bg-on-tertiary-container`
  if (item.state === 'blocked') return `${base} bg-amber-400`
  if (item.state === 'na') return `${base} border-2 border-dashed border-outline-variant`
  if (item.key === 'mapping') return `${base} bg-error`
  return `${base} border-2 border-outline-variant`
}

const link = 'inline-flex items-center gap-[2px] font-medium text-secondary hover:underline'

export default function NextStepBar({ checklist, onRefresh, refreshing }: { checklist: Checklist; onRefresh: () => void; refreshing: boolean }) {
  const next = checklist.next
  const a = next?.action
  return (
    <div className="flex flex-wrap items-center gap-x-[14px] gap-y-sm px-[20px] py-[10px] border-t border-outline-variant/40 text-body-sm">
      <div role="img" aria-label={`${checklist.done}/${checklist.total} bước xong`} className="flex items-center gap-[6px]">
        {checklist.items.map(item => <span key={item.key} title={`${item.title}: ${item.reason}`} className={dot(item, item === next)} />)}
      </div>
      <span className="font-mono text-label-sm text-on-surface-variant">{checklist.done}/{checklist.total}</span>
      {next ? (
        <>
          <span className="font-semibold text-on-surface">Việc tiếp theo:</span>
          <span className="min-w-0 text-on-surface">{next.title} <span className="text-on-surface-variant">— {next.reason}</span></span>
          {next.key === 'files' && <a href="#canvas" className={link}>Tới vùng in<Icon name="south" className="text-[16px]" /></a>}
          {a?.kind === 'link' && <Link href={a.href} className={link}>{a.label}<Icon name="open_in_new" className="text-[15px]" /></Link>}
          {a?.kind === 'refresh' && (
            <button type="button" onClick={onRefresh} disabled={refreshing} className={`${link} disabled:opacity-40`}>
              <Icon name="refresh" className="text-[16px]" />{refreshing ? 'Đang nạp…' : a.label}
            </button>
          )}
        </>
      ) : (
        <span className="text-on-surface-variant">Không còn bước nào cần làm</span>
      )}
    </div>
  )
}
