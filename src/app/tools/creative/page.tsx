'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate, useCurrentUser } from '@/components/RoleGate'
import { GenerateForm } from '@/components/creative/GenerateForm'
import { JobCard } from '@/components/creative/JobCard'
import { type Draft, type Job, type Provider, type RefImage, PROVIDER_LABEL, STATUS_LABEL } from '@/components/creative/types'

type SettingsView = { hasKie: boolean; kieMasked: string | null; hasReplicate: boolean; replicateMasked: string | null }

const CHINA_MARKERS = ['qwen', 'bytedance', 'seedream', 'wan', 'hunyuan', 'tencent', 'kling', 'minimax', 'hailuo', 'vidu', 'zhipu', 'z-image', 'glm']
const emptyDraft: Draft = { provider: 'kie', model: '', prompt: '', images: [], options: {} }
const POLL_MS = 3000

function isChina(model: string) {
  const m = model.toLowerCase()
  return CHINA_MARKERS.some(k => m.includes(k))
}

export default function CreativePage() {
  const { user } = useCurrentUser()
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [filter, setFilter] = useState({ provider: '', model: '', status: '' })
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenMessage, setTokenMessage] = useState<string | null>(null)
  const pollers = useRef<Set<string>>(new Set())

  const loadJobs = useCallback(async () => {
    const q = new URLSearchParams()
    if (filter.provider) q.set('provider', filter.provider)
    if (filter.model) q.set('model', filter.model)
    if (filter.status) q.set('status', filter.status)
    const res = await fetch(`/api/tools/creative/jobs?${q.toString()}`)
    const json = await res.json()
    if (res.ok) setJobs(json.jobs ?? [])
  }, [filter])

  useEffect(() => { loadJobs() }, [loadJobs])
  useEffect(() => { fetch('/api/tools/creative/settings').then(r => r.json()).then(setSettings).catch(() => {}) }, [])

  const upsert = useCallback((job: Job) => {
    setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id)
      if (i === -1) return [job, ...prev]
      const next = prev.slice(); next[i] = job; return next
    })
  }, [])

  useEffect(() => {
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'running')
    for (const job of active) {
      if (pollers.current.has(job.id)) continue
      pollers.current.add(job.id)
      const tick = async () => {
        try {
          const res = await fetch(`/api/tools/creative/jobs/${job.id}`)
          const json = await res.json()
          if (!res.ok) { pollers.current.delete(job.id); return }
          upsert(json.job)
          if (json.job.status === 'queued' || json.job.status === 'running') setTimeout(tick, POLL_MS)
          else pollers.current.delete(job.id)
        } catch {
          setTimeout(tick, POLL_MS * 2)
        }
      }
      setTimeout(tick, POLL_MS)
    }
  }, [jobs, upsert])

  async function submit() {
    setBusy(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/tools/creative/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Không tạo được job')
      upsert(json.job)
    } catch (err: any) {
      setSubmitError(err.message)
      loadJobs()
    } finally {
      setBusy(false)
    }
  }

  async function reuse(job: Job) {
    const images: RefImage[] = []
    for (const name of job.refImages) {
      try {
        const blob = await fetch(`/api/tools/creative/file/${job.id}/${name}`).then(r => r.blob())
        const dataUrl = await new Promise<string>(resolve => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(blob) })
        images.push({ dataUrl, name })
      } catch {}
    }
    const options: Record<string, string> = {}
    for (const [k, v] of Object.entries(job.input ?? {})) if (typeof v === 'string' && k !== 'prompt') options[k] = v
    setDraft({ provider: job.provider, model: job.model, prompt: job.prompt, images, options })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function remove(job: Job) {
    if (!confirm('Xoá job này và các ảnh kết quả?')) return
    await fetch(`/api/tools/creative/jobs/${job.id}`, { method: 'DELETE' })
    setJobs(prev => prev.filter(j => j.id !== job.id))
  }

  async function saveToken() {
    setTokenMessage(null)
    const res = await fetch('/api/tools/creative/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicateToken: tokenInput }) })
    const json = await res.json()
    if (!res.ok) { setTokenMessage(json.error || 'Không lưu được token'); return }
    setSettings(json)
    setTokenInput('')
    setTokenMessage('Đã lưu Replicate token.')
  }

  const modelChoices = useMemo(() => Array.from(new Set(jobs.map(j => j.model))).sort(), [jobs])
  const counts = useMemo(() => ({ running: jobs.filter(j => j.status === 'running' || j.status === 'queued').length, done: jobs.filter(j => j.status === 'done').length, failed: jobs.filter(j => j.status === 'failed').length }), [jobs])

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
          <h2 className="text-display-md font-bold text-primary">Creative</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Thử model tạo ảnh trên Kie và Replicate: prompt + ảnh tham chiếu + model. Ưu tiên model Trung Quốc.</p>
        </header>

        <div className="flex flex-col gap-xl">
          <GenerateForm draft={draft} onChange={setDraft} onSubmit={submit} busy={busy} error={submitError} />

          {user?.role === 'SUPERADMIN' && (
            <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">key</span>
                <h3 className="text-headline-sm text-primary">API keys</h3>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-lg p-lg">
                <div>
                  <p className="text-label-sm text-on-surface-variant">Kie API key {settings?.hasKie ? `· đang dùng ${settings.kieMasked}` : '· chưa có'}</p>
                  <p className="mt-xs text-body-sm text-on-surface-variant">Dùng chung key đã lưu ở <a href="/cs/settings" className="text-secondary hover:underline">Cài đặt CS</a>.</p>
                </div>
                <div>
                  <p className="text-label-sm text-on-surface-variant">Replicate token {settings?.hasReplicate ? `· đang dùng ${settings.replicateMasked}` : '· chưa có'}</p>
                  <div className="mt-xs flex gap-sm">
                    <input type="password" value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="r8_… dán token mới để thay"
                      className="flex-1 rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
                    <button type="button" onClick={saveToken} disabled={!tokenInput.trim()} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Lưu</button>
                  </div>
                  {tokenMessage && <p className="mt-xs text-body-sm text-on-surface-variant">{tokenMessage}</p>}
                </div>
              </div>
            </section>
          )}

          <section>
            <div className="mb-md flex flex-wrap items-center gap-md">
              <h3 className="text-headline-sm text-primary">Lịch sử</h3>
              <span className="text-body-sm text-on-surface-variant">{counts.running} đang chạy · {counts.done} xong · {counts.failed} lỗi</span>
              <div className="ml-auto flex flex-wrap gap-sm">
                <select value={filter.provider} onChange={e => setFilter({ ...filter, provider: e.target.value })} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
                  <option value="">Mọi provider</option>
                  {(['kie', 'replicate'] as Provider[]).map(p => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
                </select>
                <select value={filter.model} onChange={e => setFilter({ ...filter, model: e.target.value })} className="max-w-[260px] rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
                  <option value="">Mọi model</option>
                  {modelChoices.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm">
                  <option value="">Mọi trạng thái</option>
                  {(Object.keys(STATUS_LABEL) as Job['status'][]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
              </div>
            </div>
            {jobs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-outline-variant/40 p-xl text-center text-body-sm text-on-surface-variant">Chưa có job nào. Chọn model, nhập prompt và bấm Tạo ảnh.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-lg">
                {jobs.map(job => <JobCard key={job.id} job={job} china={isChina(job.model)} onReuse={reuse} onDelete={remove} />)}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
    </RoleGate>
  )
}
