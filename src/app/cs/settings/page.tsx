'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { CATEGORY_LABELS } from '@/lib/cs/labels'
import { CS_CATEGORIES, CS_URGENCIES } from '@/lib/cs/triage'
import { URGENCY_LABELS } from '@/lib/cs/labels'
import { fmtDate } from '@/components/cs/UrgencyChip'

type View = {
  freshdeskDomain: string; llmProvider: 'anthropic' | 'kie'; model: string; pollEnabled: boolean; killSwitch: boolean; autoReplyEnabled: boolean; autoReplyCategories: string[]; autoReplyDailyCap: number
  notifyLevels: string[]; productionDays: number; shippingDays: number; syncUpdatedSince: string | null
  hasFreshdeskApiKey: boolean; freshdeskApiKeyMasked: string | null; hasAnthropicApiKey: boolean; anthropicApiKeyMasked: string | null; hasKieApiKey: boolean; kieApiKeyMasked: string | null
}
type LastRun = { ranAt: string; ticketsSeen: number; analysed: number; autoReplied: number; fdRequests: number; error: string | null } | null

export default function CsSettingsPage() {
  const [view, setView] = useState<View | null>(null)
  const [lastRun, setLastRun] = useState<LastRun>(null)
  const [form, setForm] = useState<Partial<View>>({})
  const [secrets, setSecrets] = useState({ freshdeskApiKey: '', anthropicApiKey: '', kieApiKey: '' })
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await fetch('/api/cs/settings').then(r => r.json()).catch(() => ({}))
    if (data.settings) { setView(data.settings); setForm(data.settings) }
    setLastRun(data.lastRun ?? null)
  }, [])
  useEffect(() => { load() }, [load])

  async function save() {
    setBusy('save')
    setMessage(null)
    const body = { ...form, ...(secrets.freshdeskApiKey ? { freshdeskApiKey: secrets.freshdeskApiKey } : {}), ...(secrets.anthropicApiKey ? { anthropicApiKey: secrets.anthropicApiKey } : {}), ...(secrets.kieApiKey ? { kieApiKey: secrets.kieApiKey } : {}) }
    const res = await fetch('/api/cs/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setMessage(data.error ?? 'Lưu thất bại (cần quyền Super Admin)'); return }
    setSecrets({ freshdeskApiKey: '', anthropicApiKey: '', kieApiKey: '' })
    setMessage('Đã lưu.')
    load()
  }

  async function test() {
    setBusy('test')
    setMessage(null)
    const res = await fetch('/api/cs/settings/test', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setMessage(data.error ?? 'Không test được'); return }
    setMessage(`Freshdesk: ${data.freshdesk.ok ? `OK (${data.freshdesk.tickets} ticket trong 1h)` : data.freshdesk.error} · Model: ${data.llm.ok ? 'OK' : data.llm.error}`)
  }

  const toggleIn = (key: 'autoReplyCategories' | 'notifyLevels', value: string) => {
    const list = (form[key] ?? []) as string[]
    setForm({ ...form, [key]: list.includes(value) ? list.filter(x => x !== value) : [...list, value] })
  }

  const input = (label: string, key: keyof View, type: 'text' | 'number' = 'text') => (
    <label className="block">
      <span className="text-label-sm text-on-surface-variant">{label}</span>
      <input type={type} value={(form[key] as any) ?? ''} onChange={e => setForm({ ...form, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
    </label>
  )
  const check = (label: string, key: keyof View, danger = false) => (
    <label className={`flex items-center gap-sm text-body-sm ${danger ? 'text-error' : ''}`}>
      <input type="checkbox" checked={!!form[key]} onChange={e => setForm({ ...form, [key]: e.target.checked })} /> {label}
    </label>
  )
  const card = (title: string, children: React.ReactNode) => (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">{title}</h3></div>
      <div className="space-y-md p-lg">{children}</div>
    </section>
  )

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
            <h2 className="text-display-md font-bold text-primary">Cài đặt CS</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">Khoá API, phạm vi agent được tự trả lời, thông báo.</p>
          </div>
          <div className="flex gap-sm">
            <button onClick={test} disabled={busy !== null} className="rounded-lg border border-outline-variant/40 px-lg py-sm text-label-md text-primary disabled:opacity-50">{busy === 'test' ? 'Đang test…' : 'Test kết nối'}</button>
            <button onClick={save} disabled={busy !== null || !view} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          </div>
        </header>
        {message && <p className="mb-md rounded-lg bg-surface-container px-md py-sm text-body-sm text-on-surface-variant">{message}</p>}

        {view && (
          <div className="grid grid-cols-1 gap-lg xl:grid-cols-2">
            {card('Freshdesk', <>
              {input('Domain (phần trước .freshdesk.com)', 'freshdeskDomain')}
              <label className="block">
                <span className="text-label-sm text-on-surface-variant">API key {view.hasFreshdeskApiKey ? `· đang dùng ${view.freshdeskApiKeyMasked}` : '· chưa có'}</span>
                <input type="password" value={secrets.freshdeskApiKey} onChange={e => setSecrets({ ...secrets, freshdeskApiKey: e.target.value })} placeholder="Dán key mới để thay" className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
              </label>
              <p className="text-label-sm text-on-surface-variant">Mốc đồng bộ: {view.syncUpdatedSince ? fmtDate(view.syncUpdatedSince, true) : 'chưa chạy (lần đầu lấy 7 ngày)'}</p>
            </>)}

            {card('Model phân tích', <>
              <div className="flex gap-lg text-body-sm">
                <label className="flex items-center gap-sm"><input type="radio" name="llmProvider" checked={form.llmProvider === 'kie'} onChange={() => setForm({ ...form, llmProvider: 'kie' })} /> Kie.ai (api.kie.ai/claude)</label>
                <label className="flex items-center gap-sm"><input type="radio" name="llmProvider" checked={form.llmProvider === 'anthropic'} onChange={() => setForm({ ...form, llmProvider: 'anthropic' })} /> Anthropic trực tiếp</label>
              </div>
              <label className="block">
                <span className="text-label-sm text-on-surface-variant">Kie API key {view.hasKieApiKey ? `· đang dùng ${view.kieApiKeyMasked}` : '· chưa có'}</span>
                <input type="password" value={secrets.kieApiKey} onChange={e => setSecrets({ ...secrets, kieApiKey: e.target.value })} placeholder="Dán key mới để thay" className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
                <span className="text-label-sm text-on-surface-variant">Key phải được bật quyền model chat (Claude) tại kie.ai/api-key — bấm "Test kết nối" để kiểm tra.</span>
              </label>
              <label className="block">
                <span className="text-label-sm text-on-surface-variant">Anthropic API key {view.hasAnthropicApiKey ? `· đang dùng ${view.anthropicApiKeyMasked}` : '· chưa có'}</span>
                <input type="password" value={secrets.anthropicApiKey} onChange={e => setSecrets({ ...secrets, anthropicApiKey: e.target.value })} placeholder="sk-ant-…" className="mt-xs w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
              </label>
              {input('Model (slug trên Kie: gpt-6.1-sol, gpt-6-luna, claude-opus-5-5…; Anthropic trực tiếp chỉ nhận claude-*)', 'model')}
            </>)}

            {card('Agent', <>
              {check('Tự đồng bộ Freshdesk mỗi 2 phút', 'pollEnabled')}
              {check('KILL SWITCH — chặn mọi thư agent tự gửi', 'killSwitch', true)}
              {check('Cho phép agent tự trả lời khách', 'autoReplyEnabled')}
              <div>
                <p className="text-label-sm text-on-surface-variant">Loại ticket agent được tự trả lời (loại ngoài &quot;Hỏi đơn hàng&quot; cần có case đang dùng trong thư viện)</p>
                <div className="mt-xs grid grid-cols-2 gap-xs">
                  {CS_CATEGORIES.filter(c => c !== 'SPAM').map(c => (
                    <label key={c} className="flex items-center gap-sm text-body-sm"><input type="checkbox" checked={(form.autoReplyCategories ?? []).includes(c)} onChange={() => toggleIn('autoReplyCategories', c)} /> {CATEGORY_LABELS[c]}</label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-md">
                {input('Tối đa thư tự gửi / ngày', 'autoReplyDailyCap', 'number')}
                {input('Ngày sản xuất', 'productionDays', 'number')}
                {input('Ngày vận chuyển', 'shippingDays', 'number')}
              </div>
            </>)}

            {card('Thông báo', <>
              <p className="text-label-sm text-on-surface-variant">Bắn Telegram khi ticket ở mức (bot cấu hình ở <Link href="/tools/resources" className="text-secondary">Tools → Resources</Link>)</p>
              <div className="flex flex-wrap gap-md">
                {CS_URGENCIES.map(u => (
                  <label key={u} className="flex items-center gap-sm text-body-sm"><input type="checkbox" checked={(form.notifyLevels ?? []).includes(u)} onChange={() => toggleIn('notifyLevels', u)} /> {URGENCY_LABELS[u]}</label>
                ))}
              </div>
              <p className="text-label-sm text-on-surface-variant">Digest 09:00 mỗi sáng: số ticket chờ xử lý theo mức.</p>
            </>)}

            {card('Lần chạy gần nhất', lastRun ? (
              <ul className="text-body-sm">
                <li>Lúc: {fmtDate(lastRun.ranAt, true)}</li>
                <li>Ticket đã xem: {lastRun.ticketsSeen} · phân tích: {lastRun.analysed} · agent trả lời: {lastRun.autoReplied} · request Freshdesk: {lastRun.fdRequests}</li>
                {lastRun.error && <li className="text-error">Lỗi: {lastRun.error}</li>}
              </ul>
            ) : <p className="text-body-sm text-on-surface-variant">Chưa chạy lần nào.</p>)}
          </div>
        )}
      </main>
    </div>
    </RoleGate>
  )
}
