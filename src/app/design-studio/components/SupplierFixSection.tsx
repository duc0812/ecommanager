'use client'
import { useCallback, useEffect, useState } from 'react'
import type { SupplierFixList, SupplierFixRow } from './types'
import { LINE_FIX_REASONS } from '@/lib/line-fix'
import { StoreLabel } from '@/components/StoreFilter'
import { copyText, postJson, requestJson, taskUrl } from './model'
import { ErrorBanner, ExtLink, Icon, Pill, STATUS_META, btn, card, chip, fmtDate, fmtDateTime, iconBtn } from './ui'

const ALL = 'ALL'
const NO_REASON = 'none'
type Kind = 'waiting' | 'told' | 'fixing'

function Rows({ kind, rows, showStore, busyKey, onOpenTask, onTold, onCopy }: {
  kind: Kind; rows: SupplierFixRow[]; showStore: boolean; busyKey: string | null
  onOpenTask: (key: string) => void; onTold: (key: string) => void; onCopy: (link: string) => void
}) {
  return (
    <div className="rounded-lg border border-outline-variant/20 overflow-x-auto">
      <table className="w-full table-fixed text-body-sm min-w-[980px]">
        <thead className="bg-surface-container">
          <tr className="text-left">
            <th className="w-[14%] px-sm py-sm">Dòng</th>
            <th className="w-[11%] px-sm py-sm">Xưởng</th>
            <th className="w-[13%] px-sm py-sm">Lý do</th>
            <th className="w-[20%] px-sm py-sm">Cần sửa ở đâu</th>
            <th className="w-[12%] px-sm py-sm">Mở lại</th>
            <th className="w-[12%] px-sm py-sm">{kind === 'fixing' ? 'Trạng thái task' : 'Duyệt bản sửa'}</th>
            <th className="w-[18%] px-sm py-sm">{kind === 'told' ? 'Đã báo' : 'Folder design'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.taskKey} className="border-t border-outline-variant/20 align-top hover:bg-surface-container-low/60">
              <td className="px-sm py-sm">
                <button type="button" onClick={() => onOpenTask(r.taskKey)} className="font-mono font-semibold text-secondary hover:underline">{r.taskKey}</button>
                <div className="text-label-sm text-on-surface-variant truncate" title={r.productTitle}>{r.productTitle}</div>
                {showStore && <StoreLabel name={r.storeName} />}
              </td>
              <td className="px-sm py-sm text-label-sm truncate">{r.supplierName ?? '—'}</td>
              <td className="px-sm py-sm text-label-sm">{r.reason ?? '—'}</td>
              <td className="px-sm py-sm text-label-sm break-words">{r.note ?? '—'}</td>
              <td className="px-sm py-sm text-label-sm">{r.reopenedBy ?? '—'}<div className="text-on-surface-variant">{fmtDate(r.reopenedAt)}</div></td>
              <td className="px-sm py-sm text-label-sm">
                {kind === 'fixing'
                  ? <Pill tone={STATUS_META[r.taskStatus].tone}>{STATUS_META[r.taskStatus].label}</Pill>
                  : r.approvedAt ? fmtDateTime(r.approvedAt) : '—'}
              </td>
              <td className="px-sm py-sm text-label-sm">
                {kind === 'told' ? (
                  <span>{r.toldBy ?? '—'}<div className="text-on-surface-variant">{r.toldAt ? fmtDateTime(r.toldAt) : ''}</div></span>
                ) : (
                  <div className="flex flex-col items-start gap-xs min-w-0">
                    {r.designLink ? (
                      <span className="flex items-center gap-xs min-w-0 max-w-full">
                        <span className="truncate"><ExtLink href={r.designLink}>Mở folder design</ExtLink></span>
                        <button type="button" className={iconBtn} aria-label={`Chép link folder design ${r.taskKey}`} title="Chép link" onClick={() => onCopy(r.designLink!)}>
                          <Icon name="content_copy" className="text-[16px]" />
                        </button>
                      </span>
                    ) : <span className="text-on-surface-variant">Chưa có link</span>}
                    {kind === 'waiting' && (
                      <button type="button" className={btn} disabled={busyKey === r.taskKey} onClick={() => onTold(r.taskKey)}>
                        <Icon name="done" className="text-[16px]" />Đã báo xưởng
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * "Đã update design / Cần báo xưởng": a design fixed after its line went to the supplier by a link (sheet, CSV) is not sent
 * again, so staff tell the supplier to open the folder again and mark it here. Hidden while there is nothing to show.
 */
export default function SupplierFixSection({ version, showStore, onOpenTask }: { version: number; showStore: boolean; onOpenTask: (key: string) => void }) {
  const [data, setData] = useState<SupplierFixList | null>(null)
  const [reason, setReason] = useState(ALL)
  const [supplier, setSupplier] = useState(ALL)
  const [showTold, setShowTold] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [info, setInfo] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (reason !== ALL) qs.set('reason', reason)
    if (supplier !== ALL) qs.set('supplier', supplier)
    const query = qs.toString()
    const r = await requestJson<SupplierFixList>(`/api/design-studio/tasks/supplier-recheck${query ? `?${query}` : ''}`)
    if (!r.ok) { setError(r.error); return }
    setError('')
    setData(r.data)
  }, [reason, supplier])

  useEffect(() => { load() }, [load, version])

  async function markTold(key: string) {
    setBusyKey(key)
    const r = await postJson<{ changed: boolean }>(taskUrl(key, '/supplier-told'), {})
    setBusyKey(null)
    if (!r.ok) { setInfo(''); setError(r.error); return }
    setError('')
    setInfo(r.data.changed ? `Đã ghi: đã báo xưởng xem lại folder design của ${key}` : `${key} đã được báo trước đó`)
    void load()
  }

  async function copyLink(link: string) {
    const absolute = link.startsWith('/') ? `${window.location.origin}${link}` : link
    setInfo(await copyText(absolute) ? 'Đã chép link folder design' : 'Không chép được')
  }

  const filtered = reason !== ALL || supplier !== ALL
  if (!data || (!filtered && data.waitingTotal === 0 && data.told.length === 0 && data.fixing.length === 0)) {
    return error ? <ErrorBanner msg={error} onClose={() => setError('')} /> : null
  }
  const rowProps = { showStore, busyKey, onOpenTask, onTold: markTold, onCopy: copyLink }
  return (
    <section aria-label="Đã update design / Cần báo xưởng" className={`${card} flex flex-col`}>
      <div className="flex items-center gap-sm flex-wrap px-md py-sm border-b border-outline-variant/20">
        <Icon name="campaign" className="text-amber-800 text-[20px]" />
        <h3 className="text-body-md font-semibold text-on-surface">Đã update design / Cần báo xưởng</h3>
        <span aria-label={`${data.waitingTotal} dòng chờ báo xưởng`}
          className={`inline-flex items-center h-5 px-[7px] rounded-full text-[11px] font-semibold ${data.waitingTotal ? 'bg-amber-100 text-amber-900' : 'bg-surface-container text-on-surface-variant'}`}>
          {data.waitingTotal}
        </span>
        <span className="text-label-sm text-on-surface-variant">Dòng gửi bằng link (sheet, CSV) đã sửa design: báo xưởng mở lại folder design, tool không ghi lại sheet.</span>
        <button type="button" className={`${btn} ml-auto`} onClick={load}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
      </div>
      <div className="px-md py-sm flex flex-col gap-sm">
        <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Lọc theo lý do">
          <span className="text-label-sm text-on-surface-variant">Lý do:</span>
          {[ALL, ...LINE_FIX_REASONS, NO_REASON].map(k => (
            <button key={k} type="button" aria-pressed={reason === k} className={chip(reason === k)} onClick={() => setReason(k)}>
              {k === ALL ? 'Tất cả' : k === NO_REASON ? '—' : k}
            </button>
          ))}
        </div>
        {data.suppliers.length > 1 && (
          <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Lọc theo xưởng">
            <span className="text-label-sm text-on-surface-variant">Xưởng:</span>
            {[{ id: ALL, name: 'Tất cả' }, ...data.suppliers].map(s => (
              <button key={s.id} type="button" aria-pressed={supplier === s.id} className={chip(supplier === s.id)} onClick={() => setSupplier(s.id)}>{s.name}</button>
            ))}
          </div>
        )}
        {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
        <ErrorBanner msg={error} onClose={() => setError('')} />

        <h4 className="text-label-md font-semibold text-on-surface">Chờ báo xưởng ({data.waiting.length})</h4>
        {data.waiting.length > 0
          ? <Rows kind="waiting" rows={data.waiting} {...rowProps} />
          : <span className="text-body-sm text-on-surface-variant">Không còn dòng nào chờ báo xưởng.</span>}

        <button type="button" aria-expanded={showTold} className="self-start inline-flex items-center gap-xs text-label-sm font-semibold text-secondary" onClick={() => setShowTold(!showTold)}>
          <Icon name={showTold ? 'expand_less' : 'expand_more'} className="text-[18px]" />Đã báo ({data.told.length}) · giữ 14 ngày
        </button>
        {showTold && (data.told.length > 0
          ? <Rows kind="told" rows={data.told} {...rowProps} />
          : <span className="text-body-sm text-on-surface-variant">Chưa có dòng nào được báo trong 14 ngày qua.</span>)}

        <h4 className="text-label-md font-semibold text-on-surface">Đang sửa ({data.fixing.length})</h4>
        {data.fixing.length > 0
          ? <Rows kind="fixing" rows={data.fixing} {...rowProps} />
          : <span className="text-body-sm text-on-surface-variant">Không có dòng đã gửi xưởng nào đang sửa.</span>}
      </div>
    </section>
  )
}
