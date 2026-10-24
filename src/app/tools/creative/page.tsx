'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate, useCurrentUser } from '@/components/RoleGate'
import { GenerateForm } from '@/components/creative/GenerateForm'
import { JobCard } from '@/components/creative/JobCard'
import { type Draft, type Job, type Provider, type RefImage, PROVIDER_LABEL, STATUS_LABEL } from '@/components/creative/types'

type SettingsView = { hasKie: boolean; kieMasked: string | null; kieSource: 'creative' | 'cs' | 'env' | null; hasReplicate: boolean; replicateMasked: string | null }
const KIE_SOURCE_LABEL = { creative: 'key riêng của Creative', cs: 'key dùng chung từ Cài đặt CS', env: 'key trong .env của server' }

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
  const [keyInputs, setKeyInputs] = useState({ kieApiKey: '', replicateToken: '' })
  const [keySaving, setKeySaving] = useState(false)
  const [tokenMessage, setTokenMessage] = useState<string | null>(null)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const filterRef = useRef(filter)
  filterRef.current = filter

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

  const matchesFilter = useCallback((job: Job) => {
    const f = filterRef.current
    return (!f.provider || job.provider === f.provider) && (!f.model || job.model === f.model) && (!f.status || job.status === f.status)
  }, [])

  const upsert = useCallback((job: Job) => {
    setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id)
      if (!matchesFilter(job)) return i === -1 ? prev : prev.filter(j => j.id !== job.id)
      if (i === -1) return [job, ...prev]
      const next = prev.slice(); next[i] = job; return next
    })
  }, [matchesFilter])

  useEffect(() => {
    const active = jobs.filter(j => j.status === 'queued' || j.status === 'running')
    for (const job of active) {
      if (timers.current.has(job.id)) continue
      let failures = 0
      const schedule = (ms: number) => { timers.current.set(job.id, setTimeout(tick, ms)) }
      const stop = () => { const t = timers.current.get(job.id); if (t) clearTimeout(t); timers.current.delete(job.id) }
      const tick = async () => {
        try {
          const res = await fetch(`/api/tools/creative/jobs/${job.id}`)
          const json = await res.json()
          if (!res.ok) { stop(); return }
          failures = 0
          upsert(json.job)
          if (json.job.status === 'queued' || json.job.status === 'running') schedule(POLL_MS)
          else stop()
        } catch {
          failures += 1
          if (failures >= 10) stop()
          else schedule(POLL_MS * 2)
        }
      }
      schedule(POLL_MS)
    }
    const map = timers.current
    return () => { map.forEach(t => clearTimeout(t)); map.clear() }
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

  async function saveKeys(body: Record<string, unknown>) {
    setTokenMessage(null)
    setKeySaving(true)
    try {
      const res = await fetch('/api/tools/creative/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) { setTokenMessage(json.error || 'Không lưu được key'); return }
      setSettings(json)
      setKeyInputs({ kieApiKey: '', replicateToken: '' })
      setTokenMessage(body.clearKieApiKey ? 'Đã bỏ key Kie riêng, quay về key chung.' : 'Đã lưu. Chọn model và tạo ảnh được ngay.')
    } finally {
      setKeySaving(false)
    }
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
              <div className="p-lg">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
                  <div>
                    <p className="text-label-sm text-on-surface-variant">Kie API key {settings?.hasKie ? `· đang dùng ${settings.kieMasked}` : '· chưa có'}</p>
                    <div className="mt-xs flex gap-sm">
                      <input type="password" value={keyInputs.kieApiKey} onChange={e => setKeyInputs({ ...keyInputs, kieApiKey: e.target.value })} placeholder="Dán key từ kie.ai/api-key"
                        className="flex-1 rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
                      <button type="button" onClick={() => saveKeys({ kieApiKey: keyInputs.kieApiKey })} disabled={keySaving || !keyInputs.kieApiKey.trim()} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Lưu</button>
                    </div>
                    <p className="mt-xs text-body-sm text-on-surface-variant">
                      {settings?.kieSource ? `Đang dùng ${KIE_SOURCE_LABEL[settings.kieSource]}. ` : ''}
                      Key phải được bật quyền cho các model ảnh muốn dùng (Kie cấp quyền theo từng model trên từng key).
                      {settings?.kieSource === 'creative' && <> <button type="button" onClick={() => saveKeys({ clearKieApiKey: true })} className="text-secondary hover:underline">Bỏ key riêng</button></>}
                    </p>
                  </div>
                  <div>
                    <p className="text-label-sm text-on-surface-variant">Replicate token {settings?.hasReplicate ? `· đang dùng ${settings.replicateMasked}` : '· chưa có'}</p>
                    <div className="mt-xs flex gap-sm">
                      <input type="password" value={keyInputs.replicateToken} onChange={e => setKeyInputs({ ...keyInputs, replicateToken: e.target.value })} placeholder="r8_… từ replicate.com/account/api-tokens"
                        className="flex-1 rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
                      <button type="button" onClick={() => saveKeys({ replicateToken: keyInputs.replicateToken })} disabled={keySaving || !keyInputs.replicateToken.trim()} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">Lưu</button>
                    </div>
                  </div>
                </div>
                {tokenMessage && <p className="mt-md text-body-sm text-on-surface-variant">{tokenMessage}</p>}
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
