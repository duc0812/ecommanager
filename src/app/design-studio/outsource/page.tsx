'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { OUTSOURCE_STATUS, type OutsourceDetail, type OutsourceRow } from '@/lib/design-outsource-shared'
import type { WorkspaceLine } from '../components/types'
import TemplateCanvas, { CanvasTools, type CanvasBg, type CanvasUpload } from '../components/TemplateCanvas'
import { ARTWORK_ACCEPT } from '../components/useArtworkUpload'
import { btn, btnPrimary, card, input, ErrorBanner, Icon } from '../components/ui'

const tabs = [
  { value: 'ASSIGNED', label: 'Được giao', statuses: ['NEW', 'ASSIGNED'] },
  { value: 'DOING', label: 'Đang làm', statuses: ['DOING', 'ASK_CUSTOMER'] },
  { value: 'REVIEW', label: 'Chờ duyệt', statuses: ['REVIEW'] },
  { value: 'REJECTED', label: 'Cần sửa', statuses: ['REJECTED'] },
  { value: 'DONE', label: 'Hoàn tất', statuses: ['DONE', 'CANCELLED'] },
]
const date = (value: string | null) => value ? new Date(value).toLocaleString('vi-VN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Chưa có hạn'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? 'Chưa xử lý được yêu cầu')
  return body
}

export default function OutsourcePage() {
  const [tasks, setTasks] = useState<OutsourceRow[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<OutsourceDetail | null>(null)
  const [tab, setTab] = useState('ASSIGNED')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [canManage, setCanManage] = useState(false)
  const [overdue, setOverdue] = useState(false)
  const initial = useRef(true)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const load = useCallback(async () => {
    const data = await request<{ tasks: OutsourceRow[]; canManage: boolean }>('/api/design-studio/outsource')
    setTasks(data.tasks); setCanManage(data.canManage); setError('')
    if (initial.current) {
      const wanted = new URLSearchParams(window.location.search).get('task')
      const first = data.tasks.find(t => t.code === wanted) ?? data.tasks[0]
      setSelected(first?.code ?? '')
      if (first) setTab(tabs.find(t => t.statuses.includes(first.status))?.value ?? 'ASSIGNED')
      initial.current = false
    } else setSelected(previous => data.tasks.some(t => t.code === previous) ? previous : '')
    setLoading(false)
  }, [])
  useEffect(() => {
    let alive = true
    const refresh = () => load().catch(e => { if (alive) { setError(e.message); setLoading(false) } })
    refresh()
    const timer = setInterval(refresh, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [load])
  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return }
    const result = await request<OutsourceDetail>(`/api/design-studio/outsource/${selected}`)
    if (selectedRef.current === selected) setDetail(result)
    return result
  }, [selected])
  useEffect(() => {
    setDetail(null)
    if (!selected) return
    const controller = new AbortController()
    const refresh = () => request<OutsourceDetail>(`/api/design-studio/outsource/${selected}`, { signal: controller.signal }).then(setDetail).catch(e => { if (!controller.signal.aborted) { setDetail(null); setError(e.message) } })
    refresh()
    const timer = setInterval(refresh, 30_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [selected])
  async function changed() {
    const [, current] = await Promise.all([load(), loadDetail()])
    if (current && selectedRef.current === current.code) setTab(tabs.find(t => t.statuses.includes(current.status))?.value ?? 'ASSIGNED')
  }
  const visible = tasks.filter(t => (tabs.find(x => x.value === tab)?.statuses.includes(t.status)) && t.code.toLowerCase().includes(query.toLowerCase()) && (!overdue || (!!t.dueAt && new Date(t.dueAt).getTime() < Date.now())))
  function choose(code: string) { setSelected(code); window.history.replaceState(null, '', `?task=${encodeURIComponent(code)}`) }
  return <RoleGate><div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 min-w-0 flex-1 p-md xl:p-xl">
    <header className="mb-lg flex items-center gap-md flex-wrap"><div><p className="text-label-sm text-on-surface-variant">Design Studio</p><h1 className="text-display-md font-bold text-primary">Design Outsource</h1><p className="text-body-sm text-on-surface-variant mt-xs">{canManage ? 'Theo dõi mẫu và phản hồi cho người làm bên ngoài.' : 'Làm mẫu, tải template và gửi file để duyệt.'}</p></div><button onClick={() => load().then(loadDetail).catch(e => setError(e.message))} className={`${btn} ml-auto`}><Icon name="refresh" />Làm mới</button>{canManage && <Link href="/design-studio" className={btnPrimary}>Mở Design Tasks để giao việc</Link>}</header>
    <ErrorBanner msg={error} onClose={() => setError('')} />
    <div className="flex gap-sm overflow-x-auto pb-md" role="tablist" aria-label="Trạng thái outsource">{tabs.map(t => <button key={t.value} role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)} className={`shrink-0 rounded-lg px-md py-sm text-label-md ${tab === t.value ? 'bg-secondary text-on-secondary' : 'bg-surface-container-lowest text-on-surface border border-outline-variant/30'}`}>{t.label} <span className="ml-xs opacity-70">{tasks.filter(row => t.statuses.includes(row.status)).length}</span></button>)}</div>
    <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-lg items-start">
      <aside className={`${card} xl:sticky xl:top-md`}><div className="p-md border-b border-outline-variant/20 space-y-sm"><input aria-label="Tìm mã outsource" value={query} onChange={e => setQuery(e.target.value)} className={`${input} w-full`} placeholder="Tìm mã outsource…" /><label className="flex items-center gap-sm text-label-sm"><input type="checkbox" checked={overdue} onChange={e => setOverdue(e.target.checked)} />Chỉ việc quá hạn</label></div><div className="max-h-[70vh] overflow-y-auto">{loading ? <p className="p-md text-body-sm">Đang tải công việc…</p> : visible.length === 0 ? <p className="p-md text-body-sm text-on-surface-variant">Chưa có task trong mục này.</p> : visible.map(t => <button key={t.code} onClick={() => choose(t.code)} className={`w-full border-b border-outline-variant/20 p-md text-left ${selected === t.code ? 'bg-secondary/10 border-l-4 border-l-secondary' : 'hover:bg-surface-container-low'}`}><div className="flex gap-sm">{t.referenceUrl && <img src={t.referenceUrl} alt="Mẫu tham chiếu" className="h-12 w-12 rounded object-contain bg-surface-container" />}<div><p className="font-mono text-body-sm font-bold">{t.code}</p><p className="mt-xs text-label-sm text-on-surface-variant">{OUTSOURCE_STATUS[t.status] ?? t.status}</p><p className={`text-label-sm mt-xs ${t.dueAt && new Date(t.dueAt).getTime() < Date.now() && !['DONE', 'CANCELLED'].includes(t.status) ? 'text-error' : 'text-on-surface-variant'}`}>Hạn {date(t.dueAt)}</p></div></div></button>)}</div></aside>
      {detail ? <OutsourceWorkspace key={`${detail.code}:${detail.revision}`} detail={detail} onChanged={changed} /> : <div className={`${card} p-2xl text-center text-on-surface-variant`}><Icon name="handshake" className="text-[40px]" /><p className="mt-md">{selected ? 'Đang mở task…' : 'Chọn một task để bắt đầu.'}</p></div>}
    </div>
  </main></div></RoleGate>
}

function OutsourceWorkspace({ detail: d, onChanged }: { detail: OutsourceDetail; onChanged: () => Promise<void> }) {
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(40)
  const [area, setArea] = useState(d.slots[0] ?? 'Print')
  const [progress, setProgress] = useState<CanvasUpload['busy']>(null)
  const picker = useRef<HTMLInputElement>(null)
  const target = useRef({ kind: 'PRINT', area: d.slots[0] ?? 'Print' })
  const base = `/api/design-studio/outsource/${d.code}`
  const editable = !d.canManage && ['DOING', 'REJECTED'].includes(d.status)
  async function action(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError('')
    try { await request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revision: d.revision, ...extra }) }); setMessage(''); await onChanged() }
    catch (e) { setError(e instanceof Error ? e.message : 'Lỗi kết nối') }
    finally { setBusy(false) }
  }
  function pick(kind: string, part: string) {
    target.current = { kind, area: part }
    if (picker.current) { picker.current.accept = kind === 'MOCKUP' ? 'image/png,image/jpeg' : ARTWORK_ACCEPT; picker.current.click() }
  }
  async function upload(files: File[], kind: string, part: string | null) {
    if (busy || !editable) return
    setBusy(true); setError('')
    try {
      for (const file of files) {
        const fileArea = part ?? d.slots.find(s => s.toLowerCase() === file.name.replace(/\.[^.]+$/, '').toLowerCase()) ?? area
        setProgress({ area: fileArea, pct: 0, label: file.name, more: files.length - 1 })
        const query = new URLSearchParams({ fileName: file.name, kind, printArea: fileArea, revision: String(d.revision) })
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('PUT', `${base}/artwork?${query}`)
          xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
          xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(p => p ? { ...p, pct: Math.round(event.loaded / event.total * 100) } : null) }
          xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) resolve(); else { try { reject(new Error(JSON.parse(xhr.responseText).error)) } catch { reject(new Error('Upload chưa thành công')) } } }
          xhr.onerror = () => reject(new Error('Mất kết nối khi upload'))
          xhr.send(file)
        })
      }
      setNotice('Đã upload file. Kiểm tra mẫu trước khi gửi duyệt.')
      await onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Lỗi upload') }
    finally { setBusy(false); setProgress(null) }
  }
  const canvasLine: WorkspaceLine = { id: d.code, shopifyLineId: '', linePosition: 0, sku: null, productTitle: '', variantTitle: null, qty: 1, isNonProduct: false, customized: d.personalization.length > 0, variantOptions: {}, attributesLoaded: true, personalization: d.personalization, customallPending: false, customerDesignLink: null, customizedUrl: null, previewUrl: null, imageUrl: null, imageIsVariant: false, sourcePrintFiles: [], supplier: null, supplierSku: null, templateUrl: d.templateUrl, masterArtworkUrl: null, libraryDesignLink: null, designStatus: d.status, designDriveLink: null, designNote: null, printAreas: d.slots, artworks: d.artworks }
  const canvasUpload: CanvasUpload | null = editable && !busy ? { onDrop: (part, files) => upload(files, 'PRINT', part), onReject: setError, onPick: part => pick('PRINT', part), onPickMany: () => pick('PRINT', area), fallbackArea: area, busy: progress } : progress ? { onDrop: () => {}, onReject: setError, onPick: () => {}, onPickMany: () => {}, fallbackArea: area, busy: progress } : null
  const mockup = d.artworks.find(f => f.kind === 'MOCKUP')
  return <div className="min-w-0 space-y-md">
    <section className={`${card} p-lg`}><div className="flex items-center gap-sm flex-wrap"><h2 className="font-mono text-headline-sm font-bold">{d.code}</h2><span className="rounded-full bg-secondary/10 text-secondary px-sm py-xs text-label-sm">{OUTSOURCE_STATUS[d.status]}</span><span className="text-body-sm text-on-surface-variant ml-auto">Hạn trả {date(d.dueAt)}</span></div>
      <div className="flex gap-sm flex-wrap mt-md">{!d.canManage && <>{['ASSIGNED', 'REJECTED'].includes(d.status) && <button disabled={busy} className={btnPrimary} onClick={() => action('start')}>Bắt đầu làm</button>}{editable && <button disabled={busy || d.templateChanged || !d.templateConfirmed || d.qa.some(q => q.state === 'missing')} className={btnPrimary} onClick={() => action('submit')}>Gửi duyệt</button>}{d.status === 'REVIEW' && <button disabled={busy} className={btn} onClick={() => action('withdraw')}>Rút về để sửa</button>}{d.status === 'ASK_CUSTOMER' && <button disabled={busy} className={btnPrimary} onClick={() => action('resume')}>Tiếp tục làm</button>}</>}{d.canManage && d.internalTaskKey && <Link href={`/design-studio?task=${encodeURIComponent(d.internalTaskKey)}`} className={btnPrimary}>Mở task gốc để duyệt hoặc trả sửa</Link>}</div>
      <ErrorBanner msg={error} onClose={() => setError('')} />{notice && <p role="status" className="text-body-sm text-secondary mt-sm">{notice}</p>}
    </section>
    <section className={`${card} p-lg`}><div className="flex items-center gap-sm flex-wrap"><Icon name="download" className="text-secondary" /><h3 className="font-semibold">{d.templateLabel}</h3><span className="text-label-sm text-on-surface-variant">{d.template.widthPx} × {d.template.heightPx} px · {d.template.dpi} DPI · {d.slots.length || 1} vùng in</span><a href={d.downloadUrl} target="_blank" rel="noreferrer" className={`${btnPrimary} ml-auto`}>Tải template Drive</a><a href={d.templateUrl} target="_blank" rel="noreferrer" className={btn}>Mở trên Drive</a></div><p className="text-label-sm text-on-surface-variant mt-sm">Bleed {d.template.bleedIn} in · Safe {d.template.safeIn} in{d.template.mirror ? ' · In lật gương' : ''}</p>
      {d.templateChanged && <p className="mt-md rounded-lg bg-amber-50 p-md text-amber-900 text-body-sm">Template đã thay đổi. Nhờ nội bộ cập nhật gói trước khi gửi duyệt.</p>}{!d.templateChanged && !d.templateConfirmed && <div className="mt-md rounded-lg bg-amber-50 p-md text-amber-900 text-body-sm">Gói template hoặc yêu cầu đã cập nhật. Tải lại và kiểm tra trước khi làm tiếp. {!d.canManage && <button disabled={busy} onClick={() => action('confirm-template')} className={`${btn} ml-sm`}>Tôi đã kiểm tra bản mới</button>}</div>}
    </section>
    <section className={`${card} p-lg`}><h3 className="font-semibold mb-sm">Yêu cầu thiết kế</h3><p className="text-body-sm whitespace-pre-wrap">{d.brief}</p>{d.technicalOptions.length > 0 && <p className="mt-sm text-body-sm font-semibold">{d.technicalOptions.map(o => `${o.key}: ${o.value}`).join(" · ")}</p>}{d.personalization.length > 0 && <div className="mt-md divide-y divide-outline-variant/20">{d.personalization.map((f, i) => <div key={i} className="flex gap-md items-start py-sm text-body-sm"><span className="w-32 shrink-0 text-on-surface-variant">{f.key}</span><b className="flex-1 break-words whitespace-pre-wrap">{f.value}</b><button className="text-secondary text-label-sm" onClick={() => navigator.clipboard.writeText(f.value).then(() => setNotice('Đã chép nội dung cần in.')).catch(() => setError('Chưa chép được, hãy chọn và copy thủ công.'))}>Copy</button></div>)}</div>}</section>
    <section className={`${card} p-md`}><div className="flex items-center gap-md flex-wrap mb-md"><h3 className="font-semibold">File in trên template</h3><CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!d.template.guideImageUrl} /></div>{editable && <label className="flex gap-sm items-center text-label-sm mb-sm">Vùng nhận file<select aria-label="Vùng nhận file" value={area} onChange={e => setArea(e.target.value)} className={input}>{(d.slots.length ? d.slots : ['Print']).map(s => <option key={s}>{s}</option>)}</select></label>}<TemplateCanvas template={d.template} line={canvasLine} slots={d.slots} bg={bg} guide={guide} upload={canvasUpload} /><input aria-label="Upload file outsource" ref={picker} type="file" multiple accept={target.current.kind === 'MOCKUP' ? 'image/png,image/jpeg' : ARTWORK_ACCEPT} className="hidden" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; upload(files, target.current.kind, target.current.area) }} /></section>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-md"><section className={`${card} p-md`}><h3 className="font-semibold mb-md">Mẫu tham chiếu</h3>{d.referenceUrl ? <a href={d.referenceUrl} target="_blank" rel="noreferrer"><img src={d.referenceUrl} alt="Mẫu cần làm" className="w-full h-64 object-contain" /></a> : <p className="text-body-sm text-on-surface-variant py-xl text-center">Không có ảnh tham chiếu.</p>}</section><section className={`${card} p-md`}><div className="flex gap-sm items-center mb-md"><h3 className="font-semibold">Mockup dựng từ file in</h3>{editable && <button disabled={busy} className={`${btn} ml-auto`} onClick={() => pick('MOCKUP', 'Mockup')}>Upload mockup</button>}</div>{mockup ? <a href={mockup.url} target="_blank" rel="noreferrer"><img src={mockup.url} alt="Mockup đã upload" className="w-full h-64 object-contain" /></a> : <p className="text-body-sm text-on-surface-variant py-xl text-center">Chưa có mockup.</p>}</section></div>
    <section className={`${card} p-lg`}><h3 className="font-semibold mb-md">Kiểm tra file</h3>{d.qa.map(q => <p key={q.area} className={`text-body-sm py-xs ${q.state === 'missing' ? 'text-error' : q.state === 'warning' ? 'text-amber-800' : 'text-on-tertiary-container'}`}><b>{q.area}</b> · {q.message}</p>)}{d.artworks.length > 0 && <details className="mt-md"><summary className="cursor-pointer text-body-sm text-secondary">File và phiên bản đã upload ({d.artworks.length})</summary><ul className="mt-sm divide-y divide-outline-variant/20">{d.artworks.map(f => <li key={f.id} className="flex items-center gap-sm py-sm text-body-sm"><span className="flex-1 break-all">{f.kind === 'MOCKUP' ? 'Mockup' : f.printArea} · v{f.version} · {f.fileName}</span><a href={`${f.url}&download=1`} className="text-secondary" target="_blank" rel="noreferrer">Tải file</a></li>)}</ul></details>}</section>
    <section className={`${card} p-lg`}><h3 className="font-semibold mb-md">Trao đổi và phản hồi</h3><div className="space-y-sm max-h-80 overflow-y-auto">{d.messages.map(m => <div key={m.id} className={`rounded-lg p-md text-body-sm ${m.side === 'INTERNAL' ? 'bg-secondary/10' : 'bg-surface-container-low'}`}><p className="text-label-sm text-on-surface-variant mb-xs">{m.side === 'INTERNAL' ? 'Nội bộ' : m.side === 'OUTSOURCE' ? 'Người làm' : 'Hệ thống'} · {date(m.createdAt)}</p><p className="whitespace-pre-wrap break-words">{m.message}</p></div>)}</div>{!['DONE', 'CANCELLED'].includes(d.status) && <form onSubmit={e => { e.preventDefault(); action('message', { message }) }} className="mt-md"><textarea aria-label="Nội dung trao đổi outsource" value={message} onChange={e => setMessage(e.target.value)} maxLength={2000} rows={3} className={`${input} w-full`} placeholder={d.canManage ? 'Phản hồi này sẽ được chia sẻ với outsource…' : 'Trao đổi hoặc hỏi thêm thông tin…'} required /><div className="flex gap-sm mt-sm"><button type="submit" disabled={busy || !message.trim()} className={btnPrimary}>Gửi trao đổi</button>{!d.canManage && ['ASSIGNED', 'DOING', 'REJECTED'].includes(d.status) && <button type="button" disabled={busy || !message.trim()} className={btn} onClick={() => action('ask', { message })}>Hỏi nội bộ và chờ phản hồi</button>}</div></form>}</section>
  </div>
}
