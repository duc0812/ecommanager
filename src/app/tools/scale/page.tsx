'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate, useCurrentUser } from '@/components/RoleGate'
import { ScaleForm } from '@/components/scale/ScaleForm'
import { ScaleJobCard } from '@/components/scale/ScaleJobCard'
import { ScaleSettings } from '@/components/scale/ScaleSettings'
import { TargetManager } from '@/components/scale/TargetManager'
import { postJson, type ScaleJobView, type ScaleTargetView } from '@/components/scale/types'

const POLL_MS = 3000
type Tab = 'scale' | 'targets' | 'settings'
const TABS: { id: Tab; label: string }[] = [{ id: 'scale', label: 'Scale' }, { id: 'targets', label: 'Sản phẩm đích' }, { id: 'settings', label: 'Cài đặt' }]
const isActive = (j: ScaleJobView) => j.status === 'describing' || j.status === 'running'

export default function ScalePage() {
  const { user } = useCurrentUser()
  const isSuperadmin = user?.role === 'SUPERADMIN'
  const [tab, setTab] = useState<Tab>('scale')
  const [targets, setTargets] = useState<ScaleTargetView[]>([])
  const [jobs, setJobs] = useState<ScaleJobView[]>([])
  const [allowFallback, setAllowFallback] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const loadJobs = useCallback(async () => {
    const res = await fetch('/api/tools/scale/jobs')
    const json = await res.json().catch(() => ({}))
    if (res.ok) { setJobs(json.jobs ?? []); setAllowFallback(!!json.allowFallback) }
  }, [])

  const loadTargets = useCallback(async () => {
    const res = await fetch('/api/tools/scale/targets')
    const json = await res.json().catch(() => ({}))
    if (res.ok) setTargets(json.targets ?? [])
  }, [])

  useEffect(() => { loadJobs(); loadTargets() }, [loadJobs, loadTargets])

  const upsert = useCallback((job: ScaleJobView) => {
    setJobs(prev => {
      const i = prev.findIndex(j => j.id === job.id)
      if (i === -1) return [job, ...prev]
      const next = prev.slice(); next[i] = { ...prev[i], ...job }; return next
    })
  }, [])

  useEffect(() => {
    for (const job of jobs.filter(isActive)) {
      if (timers.current.has(job.id)) continue
      let failures = 0
      const schedule = (ms: number) => { timers.current.set(job.id, setTimeout(tick, ms)) }
      const stop = () => { const t = timers.current.get(job.id); if (t) clearTimeout(t); timers.current.delete(job.id) }
      const tick = async () => {
        try {
          const res = await fetch(`/api/tools/scale/jobs/${job.id}`)
          const json = await res.json()
          if (!res.ok) { stop(); return }
          failures = 0
          upsert(json.job)
          if (isActive(json.job)) schedule(POLL_MS)
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

  async function act(action: () => Promise<any>) {
    setError(null)
    try {
      upsert((await action()).job)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err: any) {
      setError(err.message)
      loadJobs()
    }
  }

  async function submit(image: { dataUrl: string; name: string }, targetId: string) {
    setBusy(true)
    await act(() => postJson('/api/tools/scale/jobs', { targetId, image }))
    setBusy(false)
  }

  async function remove(job: ScaleJobView) {
    if (!confirm('Xoá job này và ảnh kết quả?')) return
    try {
      await postJson(`/api/tools/scale/jobs/${job.id}`, undefined, 'DELETE')
      setJobs(prev => prev.filter(j => j.id !== job.id))
    } catch (err: any) {
      setError(err.message)
    }
  }

  const upsertTarget = useCallback((t: ScaleTargetView) => {
    setTargets(prev => (prev.some(x => x.id === t.id) ? prev.map(x => (x.id === t.id ? t : x)) : [...prev, t]))
  }, [])
  const removeTarget = useCallback((id: string) => setTargets(prev => prev.filter(t => t.id !== id)), [])

  const readyTargets = useMemo(() => targets.filter(t => t.ready), [targets])
  const counts = useMemo(() => ({ running: jobs.filter(isActive).length, done: jobs.filter(j => j.status === 'done').length, failed: jobs.filter(j => j.status === 'failed').length }), [jobs])

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
          <h2 className="text-display-md font-bold text-primary">Scale sản phẩm</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Up ảnh một sản phẩm, chọn sản phẩm muốn scale sang, nhận mockup cùng thiết kế trên sản phẩm mới.</p>
        </header>

        {isSuperadmin && (
          <div className="mb-lg flex gap-sm border-b border-outline-variant/20">
            {TABS.map(t => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={`px-lg py-sm text-label-md ${tab === t.id ? 'border-b-2 border-secondary text-secondary' : 'text-on-surface-variant hover:text-primary'}`}>{t.label}</button>
            ))}
          </div>
        )}

        {tab === 'targets' && isSuperadmin && <TargetManager targets={targets} onChange={upsertTarget} onRemoved={removeTarget} />}
        {tab === 'settings' && isSuperadmin && <ScaleSettings onSaved={s => setAllowFallback(s.allowFallback)} />}

        {tab === 'scale' && (
          <div className="flex flex-col gap-xl">
            <ScaleForm targets={readyTargets} busy={busy} error={error} onSubmit={submit} />
            <section>
              <div className="mb-md flex flex-wrap items-center gap-md">
                <h3 className="text-headline-sm text-primary">Lịch sử</h3>
                <span className="text-body-sm text-on-surface-variant">{counts.running} đang chạy · {counts.done} xong · {counts.failed} lỗi</span>
              </div>
              {jobs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-outline-variant/40 p-xl text-center text-body-sm text-on-surface-variant">Chưa có job nào. Up ảnh, chọn sản phẩm đích và bấm Tạo mockup.</div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-lg">
                  {jobs.map(job => (
                    <ScaleJobCard key={job.id} job={job} allowFallback={allowFallback} showDebug={isSuperadmin}
                      canDelete={isSuperadmin || (!!user && job.createdBy === user.userId)}
                      onRerun={j => act(() => postJson(`/api/tools/scale/jobs/${j.id}/rerun`))}
                      onFallback={j => act(() => postJson(`/api/tools/scale/jobs/${j.id}/fallback`))}
                      onDelete={remove} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
    </RoleGate>
  )
}
