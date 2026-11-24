'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useCurrentUser } from '@/components/RoleGate'
import { canManageOutsource } from '@/lib/roles'
import type { OutsourceManagement } from '@/lib/design-outsource-shared'
import { btn, btnPrimary, card, input, ErrorBanner, Icon } from './ui'

export default function OutsourceTaskPanel({ taskKey, onChanged }: { taskKey: string; onChanged: () => void }) {
  const { user } = useCurrentUser()
  const allowed = !!user && canManageOutsource(user)
  const [data, setData] = useState<OutsourceManagement | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [brief, setBrief] = useState('')
  const [label, setLabel] = useState('Template in')
  const [url, setUrl] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [reference, setReference] = useState('none')
  const [fields, setFields] = useState<number[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/design-studio/outsource/manage?taskKey=${encodeURIComponent(taskKey)}`, { cache: 'no-store', signal })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'Chưa nạp được thông tin outsource')
    setData(result)
    setAssigneeId(result.assignment?.assigneeId ?? result.users[0]?.id ?? '')
    setBrief(result.assignment?.brief ?? '')
    setLabel(result.assignment?.templateLabel ?? 'Template in')
    setUrl(result.assignment?.templateUrl ?? result.templateUrl)
    setFields(result.selectedFieldIndexes)
    setReference(result.reference)
  }, [taskKey])
  useEffect(() => {
    if (!allowed) return
    const controller = new AbortController()
    setData(null); setOpen(false); setFields([]); setReference('none'); setConfirmed(false); setError(''); setDueAt('')
    load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [allowed, load])
  if (!allowed) return null
  async function save(action: 'assign' | 'refresh' | 'revoke') {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/design-studio/outsource/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskKey, action, revision: data?.assignment?.revision, assigneeId, brief, templateLabel: label, templateUrl: url, dueAt: dueAt ? new Date(dueAt).toISOString() : undefined, reference, fieldIndexes: fields, shareConfirmed: confirmed }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Chưa lưu được')
      await load(); setOpen(false); setConfirmed(false); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : 'Lỗi kết nối') }
    finally { setBusy(false) }
  }
  const active = data?.assignment?.active
  return <section className={`${card} p-md`} aria-label="Giao việc outsource">
    <div className="flex items-center gap-sm flex-wrap">
      <Icon name="handshake" className="text-secondary" />
      <span className="text-label-md font-semibold">{active ? `Outsource · ${data?.assignment?.code}` : 'Design Outsource'}</span>
      {active && <Link href={`/design-studio/outsource?task=${data?.assignment?.code}`} className="text-body-sm text-secondary hover:underline">Mở trao đổi và bản nộp</Link>}
      <button type="button" onClick={() => setOpen(!open)} className={`${btn} ml-auto`} disabled={!data || busy}>{open ? 'Đóng' : active ? 'Quản lý outsource' : 'Chuyển outsource'}</button>
    </div>
    <ErrorBanner msg={error} onClose={() => setError('')} />
    {open && data && <form onSubmit={e => { e.preventDefault(); save(active ? 'refresh' : 'assign') }} className="mt-md space-y-md">
      {!data.users.length && <p className="text-body-sm text-error">Chưa có người làm. Tạo tài khoản vai trò Design Outsource trong Setup → Users & Roles.</p>}
      {!data.hasTemplate && <p className="text-body-sm text-error">Bổ sung template in cho task trước khi giao.</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <label className="text-label-sm">Người làm<select aria-label="Người làm outsource" className={`${input} w-full mt-xs`} value={assigneeId} onChange={e => setAssigneeId(e.target.value)} required disabled={!!active}>{data.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="text-label-sm">Hạn trả mới (để trống giữ hạn hiện tại)<input type="datetime-local" className={`${input} w-full mt-xs`} value={dueAt} onChange={e => setDueAt(e.target.value)} /></label>
        <label className="text-label-sm">Tên template trung lập<input className={`${input} w-full mt-xs`} value={label} maxLength={120} onChange={e => setLabel(e.target.value)} required /></label>
        <label className="text-label-sm">Link template Drive<input type="url" className={`${input} w-full mt-xs`} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://drive.google.com/file/d/.../view" required /></label>
      </div>
      <label className="block text-label-sm">Yêu cầu dành cho outsource<textarea aria-label="Yêu cầu dành cho outsource" value={brief} onChange={e => setBrief(e.target.value)} maxLength={4000} rows={3} className={`${input} block w-full mt-xs`} placeholder="Mô tả mẫu cần làm, font, màu và lưu ý kỹ thuật…" required /></label>
      <label className="block text-label-sm">Ảnh tham chiếu chia sẻ<select className={`${input} block mt-xs`} value={reference} onChange={e => setReference(e.target.value)}><option value="none">Không chia sẻ ảnh</option>{data.hasPreview && <option value="preview">Preview khách tạo</option>}{data.hasImage && <option value="image">Ảnh mẫu sản phẩm</option>}</select></label>
      {data.personalization.length > 0 && <fieldset className="rounded-lg bg-surface-container-low p-md"><legend className="text-label-sm">Chọn nội dung cần in để chia sẻ</legend>{data.personalization.map((f, i) => <label key={i} className="flex gap-sm py-xs text-body-sm"><input type="checkbox" checked={fields.includes(i)} onChange={e => setFields(previous => e.target.checked ? [...previous, i] : previous.filter(x => x !== i))} /><span>{f.key}: <b>{f.value}</b></span></label>)}</fieldset>}
      <div className="rounded-lg border border-outline-variant/30 p-md text-body-sm space-y-sm"><p className="font-semibold">Nội dung outsource sẽ nhận</p>{data.technicalOptions.map(o => <p key={o.key}>{o.key}: {o.value}</p>)}<p className="whitespace-pre-wrap">{brief || 'Chưa nhập yêu cầu'}</p><p>{label} · <span className="break-all">{url || 'Chưa có link'}</span></p>{fields.map(i => <p key={i}>{data.personalization[i]?.key}: {data.personalization[i]?.value}</p>)}<p>Ảnh: {reference === 'none' ? 'Không chia sẻ' : reference === 'preview' ? 'Preview khách tạo' : 'Ảnh mẫu sản phẩm'}</p></div>
      <label className="flex gap-sm text-body-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required /><span>Tôi đã kiểm tra brief, ảnh và file template: không chứa tên store/thông tin nội bộ; link Drive mở và tải được.</span></label>
      <div className="flex gap-sm"><button type="submit" className={btnPrimary} disabled={busy || !assigneeId || !data.hasTemplate || !confirmed}>{busy ? 'Đang lưu…' : active ? 'Cập nhật gói template và yêu cầu' : 'Giao outsource'}</button>{active && <button type="button" className={btn} disabled={busy} onClick={() => save('revoke')}>Thu hồi về nội bộ</button>}</div>
      {active && <p className="text-label-sm text-on-surface-variant">Cập nhật gói sẽ yêu cầu người làm xác nhận và nộp file theo template mới. Để đổi người làm, thu hồi rồi giao lại.</p>}
    </form>}
  </section>
}
