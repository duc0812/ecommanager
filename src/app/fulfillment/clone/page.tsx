'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate, useCurrentUser } from '@/components/RoleGate'
import { CloneForm, type PasteNotice } from './components/CloneForm'
import { CloneJobTable } from './components/CloneJobTable'
import { CloneSettings } from './components/CloneSettings'
import { NETWORK_ERROR, httpUrl, isActive, prefixOf, requestJson, type CloneJobView, type CloneJobsResponse } from './components/types'

const JOBS_URL = '/api/fulfillment/clone/jobs'
const POLL_MS = 5000
const MAX_POLL_MS = 60000

export default function CloneFromLinkPage() {
  const { user } = useCurrentUser()
  const viewer = useMemo(() => ({ id: user?.userId ?? null, superadmin: user?.role === 'SUPERADMIN' }), [user])
  const [data, setData] = useState<CloneJobsResponse | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState<PasteNotice | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const alive = useRef(true)
  const failures = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    try {
      const r = await requestJson(JOBS_URL)
      if (!r.ok || !Array.isArray(r.body.jobs)) throw new Error('load failed')
      if (!alive.current) return
      failures.current = 0
      setData(r.body)
      setLoadFailed(false)
    } catch {
      if (!alive.current) return
      failures.current += 1
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const hasActive = data?.jobs.some(isActive) ?? false

  useEffect(() => {
    if (!hasActive) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer = setTimeout(async () => {
        await load()
        if (!stopped) schedule()
      }, Math.min(POLL_MS * 2 ** failures.current, MAX_POLL_MS))
    }
    schedule()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [hasActive, load])

  useEffect(() => {
    if (notice?.jobId) document.getElementById(`clone-job-${notice.jobId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [notice])

  const upsert = useCallback((job: CloneJobView) => {
    setData(prev => prev && {
      ...prev,
      jobs: prev.jobs.some(j => j.id === job.id) ? prev.jobs.map(j => (j.id === job.id ? { ...j, ...job } : j)) : [job, ...prev.jobs],
    })
  }, [])

  async function refresh() {
    setRefreshing(true)
    await load()
    if (alive.current) setRefreshing(false)
  }

  async function submit(url: string, storeId: string, force: boolean): Promise<boolean> {
    setSubmitting(true)
    setNotice(null)
    setRowError(null)
    try {
      const r = await requestJson(JOBS_URL, { method: 'POST', body: force ? { url, storeId, force: true } : { url, storeId } })
      if (r.ok && r.body.job) {
        upsert(r.body.job)
        await load()
        return true
      }
      const jobId = typeof r.body.jobId === 'string' ? r.body.jobId : undefined
      if (jobId) await load()
      setNotice({
        error: typeof r.body.error === 'string' ? r.body.error : `Lỗi ${r.status}`,
        productUrl: httpUrl(r.body.productUrl),
        jobId,
        attempt: r.status === 409 ? { url, storeId } : undefined,
      })
      return false
    } catch {
      setNotice({ error: NETWORK_ERROR })
      return false
    } finally {
      if (alive.current) setSubmitting(false)
    }
  }

  async function act(job: CloneJobView, action: 'cancel' | 'retry') {
    setActing(job.id)
    setRowError(null)
    try {
      const r = await requestJson(`${JOBS_URL}/${encodeURIComponent(job.id)}/${action}`, { method: 'POST' })
      if (r.ok && r.body.job) upsert(r.body.job)
      else setRowError(typeof r.body.error === 'string' ? r.body.error : `Lỗi ${r.status}`)
    } catch {
      setRowError(NETWORK_ERROR)
    }
    if (alive.current) setActing(null)
    await load()
  }

  const stores = data?.stores ?? []
  const cloneStores = stores.filter(s => prefixOf(s) !== null)

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Fulfillment</p>
          <h2 className="text-display-md font-bold text-primary">Clone từ link</h2>
          <p className="mt-xs text-body-md text-on-surface-variant">Dán link sản phẩm của đối thủ, chọn store, máy xử lý sẽ clone và đăng sản phẩm lên store.</p>
        </header>

        <div className="flex flex-col gap-xl">
          <CloneForm
            ready={data !== null}
            stores={cloneStores}
            hasSkuPrefix={data?.hasSkuPrefix ?? false}
            paused={data?.paused ?? false}
            worker={data?.worker ?? null}
            busy={submitting}
            notice={notice}
            isSuperadmin={viewer.superadmin}
            onSubmit={submit}
            onDismiss={() => setNotice(null)}
          />

          <section>
            <div className="mb-md flex flex-wrap items-center gap-md">
              <h3 className="text-headline-sm text-primary">Danh sách job</h3>
              <button type="button" disabled={refreshing} onClick={refresh} className="inline-flex items-center gap-xs text-label-md text-secondary hover:underline disabled:opacity-50">
                <span className={`material-symbols-outlined text-[18px] ${refreshing ? 'animate-spin' : ''}`}>refresh</span>Làm mới
              </button>
            </div>
            {loadFailed && <p className="mb-md text-body-sm text-error">Không tải được danh sách job. Bấm Làm mới để thử lại.</p>}
            {rowError && <p className="mb-md text-body-sm text-error">{rowError}</p>}
            {data === null ? (
              !loadFailed && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>
            ) : data.jobs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-outline-variant/40 p-xl text-center text-body-sm text-on-surface-variant">Chưa có job nào. Dán link sản phẩm ở trên và bấm Clone.</div>
            ) : (
              <CloneJobTable
                jobs={data.jobs}
                stores={stores}
                viewer={viewer}
                highlightId={notice?.jobId ?? null}
                acting={acting}
                onCancel={job => act(job, 'cancel')}
                onRetry={job => act(job, 'retry')}
              />
            )}
          </section>

          {viewer.superadmin && data && (
            <CloneSettings stores={cloneStores} onPausedChange={paused => setData(prev => prev && { ...prev, paused })} />
          )}
        </div>
      </main>
    </div>
    </RoleGate>
  )
}
