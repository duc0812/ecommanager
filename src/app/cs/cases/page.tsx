'use client'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { CATEGORY_LABELS } from '@/lib/cs/labels'
import { CS_CATEGORIES } from '@/lib/cs/triage'

type Case = { id: string; title: string; category: string; situation: string; resolution: string; toneNotes: string | null; forbidden: string | null; exampleReply: string | null; active: boolean; source: string; updatedAt: string }
const empty = { title: '', category: 'ORDER_STATUS', situation: '', resolution: '', toneNotes: '', forbidden: '', exampleReply: '', active: true }

function CasesInner() {
  const params = useSearchParams()
  const [cases, setCases] = useState<Case[]>([])
  const [form, setForm] = useState(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await fetch('/api/cs/cases').then(r => r.json()).catch(() => ({}))
    setCases(data.cases ?? [])
    return (data.cases ?? []) as Case[]
  }, [])

  useEffect(() => {
    load().then(list => {
      const id = params.get('edit')
      const c = id ? list.find(x => x.id === id) : null
      if (c) edit(c)
    })
  }, [load, params])

  function edit(c: Case) {
    setEditingId(c.id)
    setForm({ title: c.title, category: c.category, situation: c.situation, resolution: c.resolution, toneNotes: c.toneNotes ?? '', forbidden: c.forbidden ?? '', exampleReply: c.exampleReply ?? '', active: c.active })
  }

  async function save() {
    setBusy(true)
    setMessage(null)
    const res = await fetch(editingId ? `/api/cs/cases/${editingId}` : '/api/cs/cases', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setMessage(data.error ?? 'Lưu thất bại'); return }
    setMessage(editingId ? 'Đã cập nhật case.' : 'Đã thêm case.')
    setEditingId(null)
    setForm(empty)
    load()
  }

  async function toggle(c: Case) {
    await fetch(`/api/cs/cases/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) })
    load()
  }

  async function remove(c: Case) {
    if (!confirm(`Xoá case "${c.title}"?`)) return
    await fetch(`/api/cs/cases/${c.id}`, { method: 'DELETE' })
    if (editingId === c.id) { setEditingId(null); setForm(empty) }
    load()
  }

  const field = (label: string, key: keyof typeof form, rows = 3, hint?: string) => (
    <label className="block">
      <span className="text-label-sm text-on-surface-variant">{label}</span>
      <textarea value={form[key] as string} onChange={e => setForm({ ...form, [key]: e.target.value })} rows={rows} className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
      {hint && <span className="text-label-sm text-on-surface-variant">{hint}</span>}
    </label>
  )

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
          <h2 className="text-display-md font-bold text-primary">Thư viện case</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Bộ luật của agent: mỗi case là một tình huống → cách xử lý → điều cấm. Agent phải dẫn chiếu case khi đề xuất.</p>
        </header>
        {message && <p className="mb-md rounded-lg bg-surface-container px-md py-sm text-body-sm text-on-surface-variant">{message}</p>}

        <div className="grid grid-cols-1 gap-lg xl:grid-cols-[1fr_420px]">
          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
            <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Case ({cases.length})</h3></div>
            <table className="w-full text-left">
              <thead className="text-label-sm uppercase text-on-surface-variant"><tr><th className="px-lg py-sm">Tiêu đề</th><th className="px-sm py-sm">Loại</th><th className="px-sm py-sm">Nguồn</th><th className="px-sm py-sm">Bật</th><th className="px-lg py-sm"></th></tr></thead>
              <tbody>
                {cases.length === 0 && <tr><td colSpan={5} className="px-lg py-xl text-center text-body-sm text-on-surface-variant">Thư viện đang trống. Thêm case đầu tiên bên phải, hoặc bấm &quot;Lưu thành case mẫu&quot; sau khi trả lời một ticket.</td></tr>}
                {cases.map(c => (
                  <tr key={c.id} className={`border-t border-outline-variant/20 ${c.active ? '' : 'opacity-60'}`}>
                    <td className="px-lg py-md"><button onClick={() => edit(c)} className="text-left text-label-md text-primary">{c.title}</button><p className="line-clamp-1 text-body-sm text-on-surface-variant">{c.situation}</p></td>
                    <td className="px-sm py-md text-body-sm">{CATEGORY_LABELS[c.category as keyof typeof CATEGORY_LABELS] ?? c.category}</td>
                    <td className="px-sm py-md text-label-sm text-on-surface-variant">{c.source === 'PROMOTED' ? 'Từ ticket' : 'Nhập tay'}</td>
                    <td className="px-sm py-md"><button onClick={() => toggle(c)} className={`rounded-full px-sm py-xs text-label-sm ${c.active ? 'bg-secondary/10 text-secondary' : 'bg-surface-container text-on-surface-variant'}`}>{c.active ? 'Đang dùng' : 'Tắt'}</button></td>
                    <td className="px-lg py-md text-right"><button onClick={() => remove(c)} className="text-label-sm text-error">Xoá</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
            <div className="flex items-center justify-between border-b border-outline-variant/20 px-lg py-md">
              <h3 className="text-headline-sm text-primary">{editingId ? 'Sửa case' : 'Thêm case'}</h3>
              {editingId && <button onClick={() => { setEditingId(null); setForm(empty) }} className="text-label-sm text-on-surface-variant">Huỷ</button>}
            </div>
            <div className="space-y-md p-lg">
              <label className="block">
                <span className="text-label-sm text-on-surface-variant">Tiêu đề</span>
                <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
              </label>
              <label className="block">
                <span className="text-label-sm text-on-surface-variant">Loại ticket</span>
                <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
                  {CS_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
              </label>
              {field('Tình huống', 'situation', 3, 'Khi nào áp dụng case này.')}
              {field('Cách xử lý', 'resolution', 4, 'Agent sẽ đề xuất và viết thư theo đây.')}
              {field('Giọng điệu', 'toneNotes', 2)}
              {field('Điều cấm', 'forbidden', 2, 'Ví dụ: không hứa hoàn tiền, không xin ảnh để chứng minh.')}
              {field('Thư mẫu (tiếng Anh)', 'exampleReply', 5)}
              <label className="flex items-center gap-sm text-body-sm"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Đang dùng</label>
              <button onClick={save} disabled={busy || !form.title || !form.situation || !form.resolution} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">{busy ? 'Đang lưu…' : editingId ? 'Lưu thay đổi' : 'Thêm case'}</button>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

export default function CsCasesPage() {
  return (
    <RoleGate>
      <Suspense fallback={null}><CasesInner /></Suspense>
    </RoleGate>
  )
}
