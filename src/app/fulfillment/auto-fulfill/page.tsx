'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { splitNdjson } from '@/lib/tracking/ndjson-stream'

type SheetConfig = { id: string; name: string; url: string; enabled: boolean; storeBase: string }
type ResultRow = { baseOrder: string; status: string; trackings: string[]; fulfilledLines: number; message?: string }

const STATUS_LABEL: Record<string, string> = {
  will_fulfill: 'Sẽ fulfill', too_recent: 'Chưa đủ tuổi', already_fulfilled: 'Đã fulfill',
  not_found: 'Không thấy đơn', needs_manual: 'Cần xử tay', error: 'Lỗi',
}

export default function AutoFulfillPage() {
  const [sheets, setSheets] = useState<SheetConfig[]>([])
  const [minAgeDays, setMinAgeDays] = useState(5)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [rows, setRows] = useState<ResultRow[]>([])
  const [message, setMessage] = useState('')

  const loadConfig = useCallback(async () => {
    const d = await fetch('/api/fulfillment/auto-fulfill/config').then(r => r.json()).catch(() => null)
    if (d) { setSheets(d.sheets ?? []); setMinAgeDays(d.minAgeDays ?? 5) }
  }, [])
  useEffect(() => { loadConfig() }, [loadConfig])

  const saveConfig = async () => {
    setMessage('Đang lưu…')
    const d = await fetch('/api/fulfillment/auto-fulfill/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheets, minAgeDays }),
    }).then(r => r.json()).catch(() => null)
    if (d) { setSheets(d.sheets ?? []); setMinAgeDays(d.minAgeDays ?? 5); setMessage('Đã lưu cấu hình.') }
    else setMessage('Lưu thất bại.')
  }

  const addSheet = () => setSheets(s => [...s, { id: String(Date.now()), name: '', url: '', enabled: true, storeBase: 'https://litzzy.com' }])
  const removeSheet = (id: string) => setSheets(s => s.filter(x => x.id !== id))
  const patchSheet = (id: string, p: Partial<SheetConfig>) => setSheets(s => s.map(x => x.id === id ? { ...x, ...p } : x))

  const run = async (apply: boolean) => {
    setRunning(true); setProgress(null); setRows([])
    setMessage(apply ? 'Đang Apply (tạo fulfillment)…' : 'Đang Preview…')
    try {
      const res = await fetch(`/api/fulfillment/auto-fulfill/run?apply=${apply ? 1 : 0}`, { method: 'POST' })
      if (!res.ok || !res.body) { const b = await res.json().catch(() => ({})); setMessage(`Lỗi: ${b.error ?? res.statusText}`); return }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let doneMsg: any = null; let err: string | null = null
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true }); const sp = splitNdjson(buf); buf = sp.rest
        for (const line of sp.lines) {
          let m: any
          try { m = JSON.parse(line) } catch { continue }
          if (m.type === 'progress') setProgress({ done: m.done, total: m.total })
          else if (m.type === 'done') doneMsg = m
          else if (m.type === 'error') err = m.error
        }
      }
      if (err) { setMessage(`Lỗi: ${err}`); return }
      if (doneMsg) {
        setRows(doneMsg.rows ?? [])
        setMessage(`${apply ? 'Apply' : 'Preview'} xong: ${doneMsg.fulfilled} fulfill, ${doneMsg.tooRecent} chưa đủ tuổi, ${doneMsg.alreadyFulfilled} đã fulfill, ${doneMsg.needsManual} cần tay, ${doneMsg.notFound} không thấy đơn, ${doneMsg.errored} lỗi / ${doneMsg.ordersChecked} đơn.`)
      }
    } catch (e: any) { setMessage(`Lỗi: ${e.message}`) }
    finally { setRunning(false); setProgress(null) }
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-full lg:w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
        <div className="flex items-center justify-between mb-lg gap-md">
          <div>
            <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Fulfillment</p>
            <h1 className="text-display-md text-primary">Auto Fulfill</h1>
          </div>
          <div className="flex items-center gap-xs">
            <button onClick={() => run(false)} disabled={running} className="bg-surface-container-lowest text-on-surface border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Preview</button>
            <button onClick={() => run(true)} disabled={running} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">{running ? (progress ? `Đang chạy ${progress.done}/${progress.total}…` : 'Đang chạy…') : 'Apply now'}</button>
          </div>
        </div>
        {message && <p className="mb-md text-body-sm text-on-surface-variant">{message}</p>}
        {running && progress && progress.total > 0 && (
          <div className="mb-md h-[6px] w-full rounded-full bg-surface-container overflow-hidden">
            <div className="h-full bg-secondary transition-all duration-300" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
        )}

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg mb-lg">
          <div className="flex items-center justify-between mb-md">
            <h2 className="text-title-md text-on-surface">Nguồn sheet</h2>
            <div className="flex items-center gap-sm">
              <label className="text-label-sm">Tuổi đơn tối thiểu (ngày)</label>
              <input type="number" min={0} value={minAgeDays} onChange={e => setMinAgeDays(Number(e.target.value))} className="w-[80px] border border-outline-variant/40 rounded-lg px-sm py-xs text-body-sm" />
              <button onClick={saveConfig} className="bg-secondary text-on-secondary px-lg py-xs rounded-lg text-label-md">Lưu</button>
            </div>
          </div>
          <div className="space-y-sm">
            {sheets.map(s => (
              <div key={s.id} className="grid grid-cols-1 md:grid-cols-[160px_1fr_180px_auto_auto] gap-sm items-center">
                <input value={s.name} onChange={e => patchSheet(s.id, { name: e.target.value })} placeholder="Tên supplier" className="border border-outline-variant/40 rounded-lg px-sm py-xs text-body-sm" />
                <input value={s.url} onChange={e => patchSheet(s.id, { url: e.target.value })} placeholder="Link Google Sheet (link-view)" className="border border-outline-variant/40 rounded-lg px-sm py-xs text-body-sm font-mono" />
                <input value={s.storeBase} onChange={e => patchSheet(s.id, { storeBase: e.target.value })} placeholder="storeBase" className="border border-outline-variant/40 rounded-lg px-sm py-xs text-body-sm" />
                <label className="text-label-sm flex items-center gap-xs"><input type="checkbox" checked={s.enabled} onChange={e => patchSheet(s.id, { enabled: e.target.checked })} /> Bật</label>
                <button onClick={() => removeSheet(s.id)} className="text-error text-label-sm">Xóa</button>
              </div>
            ))}
          </div>
          <button onClick={addSheet} className="mt-md text-secondary text-label-md">+ Thêm sheet</button>
          <p className="text-label-sm text-on-surface-variant mt-sm">Mỗi sheet phải chia sẻ "Anyone with the link → Viewer". Cron chạy 03:30 hằng ngày (tự Apply).</p>
        </div>

        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container"><tr className="text-left text-on-surface-variant">
              <th className="px-md py-sm font-medium">Order</th><th className="px-md py-sm font-medium">Tracking</th>
              <th className="px-md py-sm font-medium">Lines</th><th className="px-md py-sm font-medium">Status</th><th className="px-md py-sm font-medium">Ghi chú</th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.baseOrder}-${i}`} className="border-t border-outline-variant/20">
                  <td className="px-md py-sm font-medium">{r.baseOrder.startsWith('(') ? r.baseOrder : `#${r.baseOrder}`}</td>
                  <td className="px-md py-sm font-mono text-label-sm">{r.trackings.join(', ') || '—'}</td>
                  <td className="px-md py-sm">{r.fulfilledLines || '—'}</td>
                  <td className="px-md py-sm">{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td className="px-md py-sm text-label-sm text-on-surface-variant">{r.message ?? ''}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} className="px-md py-lg text-center text-on-surface-variant">Bấm Preview để xem kế hoạch fulfill.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
