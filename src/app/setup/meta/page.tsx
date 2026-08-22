'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import MetaBillingSyncStatus from '@/components/MetaBillingSyncStatus'
import { useCurrentUser } from '@/components/RoleGate'
import type { MetaBillingSyncJob } from '@/lib/meta-billing-sync-types'
import { isMetaBillingSyncActive } from '@/lib/meta-billing-sync-types'

type Project = { id: string; name: string }
type MetaAccount = {
  id: string
  accountId: string
  accountName: string | null
  currency: string | null
  projectId: string | null
  project: { id: string; name: string } | null
  lastSyncAt: string | null
}

export default function SetupMetaPage() {
  const [accounts, setAccounts] = useState<MetaAccount[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  const [accountId, setAccountId] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [saving, setSaving] = useState(false)
  const [currencyDrafts, setCurrencyDrafts] = useState<Record<string, string>>({})
  const [savingCurrency, setSavingCurrency] = useState<string | null>(null)
  const [currencyError, setCurrencyError] = useState<string | null>(null)
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({})
  const [updatingToken, setUpdatingToken] = useState<string | null>(null)
  const [accountNotice, setAccountNotice] = useState<string | null>(null)

  const [assignId, setAssignId] = useState('')
  const [assignProject, setAssignProject] = useState('')
  const [assigning, setAssigning] = useState(false)

  const [showToken, setShowToken] = useState<Record<string, boolean>>({})
  const [startingSync, setStartingSync] = useState<string | null>(null)
  const [syncJob, setSyncJob] = useState<MetaBillingSyncJob | null>(null)
  const [syncStartError, setSyncStartError] = useState<string | null>(null)
  const wasSyncActive = useRef(false)

  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN'
  const todayKey = new Date().toISOString().split('T')[0]
  const [backfilling, setBackfilling] = useState<string | null>(null)
  const [backfillNotice, setBackfillNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [a, p] = await Promise.all([
      fetch('/api/meta/accounts').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ])
    const accountList: MetaAccount[] = Array.isArray(a) ? a : []
    setAccounts(accountList)
    setCurrencyDrafts(Object.fromEntries(accountList.map(account => [account.id, account.currency || 'USD'])))
    setProjects(Array.isArray(p) ? p : [])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let cancelled = false

    async function pollSyncJob() {
      try {
        const res = await fetch('/api/meta/sync', { cache: 'no-store' })
        const result = await res.json()
        if (!res.ok || cancelled) return
        const nextJob = (result.job ?? null) as MetaBillingSyncJob | null
        const nextActive = isMetaBillingSyncActive(nextJob)
        const shouldReload = wasSyncActive.current && !nextActive
        wasSyncActive.current = nextActive
        setSyncJob(nextJob)
        if (shouldReload) await load()
      } catch {
        // Keep the current progress visible; the next poll can recover.
      }
    }

    void pollSyncJob()
    const timer = window.setInterval(pollSyncJob, 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [load])

  async function addAccount() {
    if (!accountId || !accessToken) return
    setSaving(true)
    setCurrencyError(null)
    const res = await fetch('/api/meta/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, accountName, accessToken, currency }),
    })
    const result = await res.json()
    if (!res.ok) {
      setCurrencyError(result.error || 'Không thể lưu tài khoản Meta.')
      setSaving(false)
      return
    }
    setAccountId(''); setAccountName(''); setAccessToken(''); setCurrency('USD')
    await load()
    setSaving(false)
  }

  async function saveCurrency(account: MetaAccount) {
    const nextCurrency = currencyDrafts[account.id] || 'USD'
    setSavingCurrency(account.id)
    setCurrencyError(null)
    const res = await fetch('/api/meta/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: account.id, currency: nextCurrency }),
    })
    const result = await res.json()
    if (!res.ok) setCurrencyError(result.error || 'Không thể lưu tiền tệ.')
    else await load()
    setSavingCurrency(null)
  }

  async function updateAccessToken(account: MetaAccount) {
    const nextToken = tokenDrafts[account.id]?.trim()
    if (!nextToken) {
      setCurrencyError(`Vui lòng dán token mới cho ${account.accountName || account.accountId}.`)
      return
    }
    setUpdatingToken(account.id)
    setCurrencyError(null)
    setAccountNotice(null)
    const res = await fetch('/api/meta/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: account.id, accessToken: nextToken }),
    })
    const result = await res.json()
    if (!res.ok) {
      setCurrencyError(result.error || 'Không thể cập nhật Access Token.')
    } else {
      setTokenDrafts(current => ({ ...current, [account.id]: '' }))
      setAccountNotice(`Đã cập nhật token cho ${account.accountName || account.accountId}. Bạn có thể bấm Sync để kiểm tra.`)
    }
    setUpdatingToken(null)
  }

  async function deleteAccount(id: string) {
    if (!confirm('Xóa tài khoản này và toàn bộ billing data?')) return
    await fetch('/api/meta/accounts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await load()
  }

  async function assignToProject() {
    if (!assignId) return
    setAssigning(true)
    await fetch('/api/meta/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: assignId, projectId: assignProject || null }),
    })
    setAssignId(''); setAssignProject('')
    await load()
    setAssigning(false)
  }

  async function syncAccount(id: string) {
    setStartingSync(id)
    setSyncStartError(null)
    try {
      const res = await fetch('/api/meta/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Không thể bắt đầu Meta billing sync.')
      const nextJob = result.job as MetaBillingSyncJob
      wasSyncActive.current = isMetaBillingSyncActive(nextJob)
      setSyncJob(nextJob)
    } catch (error) {
      setSyncStartError(error instanceof Error ? error.message : 'Không thể bắt đầu Meta billing sync.')
    } finally {
      setStartingSync(null)
    }
  }

  async function backfillInsights(account: MetaAccount) {
    if (!isAdmin) return
    setBackfilling(account.id)
    setBackfillNotice(null)
    try {
      const params = new URLSearchParams({ accountId: account.id, fromProjectStart: '1' })
      const res = await fetch(`/api/meta/sync-insights?${params.toString()}`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || 'Backfill thất bại.')
      const errs: string[] = Array.isArray(result.errors) ? result.errors : []
      const label = account.accountName || account.accountId
      setBackfillNotice(
        `Backfill ${label}: ${result.synced ?? 0} ngày (${result.range?.since ?? '?'} → ${result.range?.until ?? todayKey})`
        + (errs.length ? ` · Lỗi: ${errs.join('; ')}` : ''),
      )
      await load()
    } catch (error) {
      setBackfillNotice(error instanceof Error ? error.message : 'Backfill thất bại.')
    } finally {
      setBackfilling(null)
    }
  }

  const inputCls = 'bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all w-full'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="mb-xl">
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Setup</p>
          <h2 className="text-display-md font-bold text-primary">Meta Ads</h2>
          <p className="text-on-surface-variant text-body-md mt-xs">Kết nối tài khoản quảng cáo Meta và gắn với dự án</p>
          <p className="text-body-sm text-on-surface-variant mt-sm">
            <span className="material-symbols-outlined text-[14px] align-middle mr-xs">info</span>
            VND exchange rates are managed in{' '}
            <a href="/setup/meta-rates" className="text-secondary underline hover:opacity-80">Setup → Meta Exchange Rate</a>.
          </p>
        </header>

        {syncStartError && (
          <div className="mb-lg flex items-center gap-md rounded-xl border border-error/20 bg-error-container/20 px-lg py-md text-error">
            <span className="material-symbols-outlined">error</span>
            <p className="text-body-sm">Lỗi sync: {syncStartError}</p>
          </div>
        )}

        <MetaBillingSyncStatus job={syncJob} />

        {currencyError && (
          <div className="mb-lg rounded-xl bg-error-container/20 border border-error/20 px-lg py-md flex items-center gap-md text-error">
            <span className="material-symbols-outlined">error</span>
            <p className="text-body-sm">{currencyError}</p>
          </div>
        )}

        {accountNotice && (
          <div className="mb-lg rounded-xl bg-on-tertiary-container/10 border border-on-tertiary-container/20 px-lg py-md flex items-center gap-md text-on-tertiary-container">
            <span className="material-symbols-outlined">check_circle</span>
            <p className="text-body-sm">{accountNotice}</p>
          </div>
        )}

        {backfillNotice && (
          <div className="mb-lg rounded-xl bg-amber-50 border border-amber-300 px-lg py-md flex items-start gap-md text-amber-900">
            <span className="material-symbols-outlined">history</span>
            <p className="text-body-sm">{backfillNotice}</p>
          </div>
        )}

        <div className="grid grid-cols-12 gap-lg">

          {/* Left: Add account + Assign */}
          <section className="col-span-12 lg:col-span-5 space-y-lg">

            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">add_circle</span>
                <h3 className="text-headline-sm text-primary">Thêm Ad Account</h3>
              </div>
              <div className="p-lg space-y-md">
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Ad Account ID *</label>
                  <input type="text" value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="act_123456789 hoặc 123456789" className={inputCls} />
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Tên tài khoản</label>
                  <input type="text" value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="VD: POD Ads Account" className={inputCls} />
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Tiền tệ</label>
                  <select value={currency} onChange={e => setCurrency(e.target.value)} className={inputCls}>
                    <option value="USD">USD</option>
                    <option value="VND">VND</option>
                  </select>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Access Token *</label>
                  <div className="relative">
                    <input
                      type={showToken['new'] ? 'text' : 'password'}
                      value={accessToken}
                      onChange={e => setAccessToken(e.target.value)}
                      placeholder="EAAxxxxxxxxxxxx..."
                      className={inputCls + ' pr-10'}
                      autoComplete="off"
                    />
                    <button type="button" onClick={() => setShowToken(s => ({ ...s, new: !s['new'] }))}
                      className="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary">
                      <span className="material-symbols-outlined text-[20px]">{showToken['new'] ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                  <p className="text-label-sm text-on-surface-variant">Cần quyền <code className="bg-surface-container px-xs rounded">ads_read</code></p>
                </div>
                <button
                  onClick={addAccount}
                  disabled={saving || !accountId || !accessToken}
                  className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  <span className={`material-symbols-outlined text-[18px] ${saving ? 'animate-spin' : ''}`}>{saving ? 'sync' : 'add_circle'}</span>
                  {saving ? 'Đang lưu...' : 'Thêm Account'}
                </button>
              </div>
            </div>

            {/* Assign to project */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">link</span>
                <h3 className="text-headline-sm text-primary">Gán vào Project</h3>
              </div>
              <div className="p-lg space-y-md">
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Ad Account</label>
                  <select value={assignId} onChange={e => setAssignId(e.target.value)} className={inputCls}>
                    <option value="">-- Chọn ad account --</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.accountName || a.accountId}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Project</label>
                  <select value={assignProject} onChange={e => setAssignProject(e.target.value)} className={inputCls}>
                    <option value="">-- Không gán --</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <button
                  onClick={assignToProject}
                  disabled={assigning || !assignId}
                  className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  <span className={`material-symbols-outlined text-[18px] ${assigning ? 'animate-spin' : ''}`}>{assigning ? 'sync' : 'link'}</span>
                  {assigning ? 'Đang gán...' : 'Lưu'}
                </button>
              </div>
            </div>

          </section>

          {/* Right: Accounts list */}
          <section className="col-span-12 lg:col-span-7">
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">campaign</span>
                <h3 className="text-headline-sm text-primary">Ad Accounts</h3>
                <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">{accounts.length}</span>
              </div>
              {loading ? (
                <div className="px-lg py-xl text-center">
                  <span className="material-symbols-outlined animate-spin text-[24px] text-on-surface-variant">sync</span>
                </div>
              ) : accounts.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">Chưa có ad account nào</div>
              ) : (
                <div className="divide-y divide-outline-variant/10">
                  {accounts.map(a => (
                    <div key={a.id} className="px-lg py-md hover:bg-surface-container-low/40 transition-colors">
                      <div className="flex items-start justify-between gap-md">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-sm flex-wrap mb-xs">
                            <span className="text-label-md text-primary">{a.accountName || a.accountId}</span>
                            <span className="font-mono text-label-sm text-on-surface-variant bg-surface-container px-xs rounded">{a.accountId}</span>
                          </div>
                          <div className="flex items-center gap-sm flex-wrap">
                            {a.project ? (
                              <span className="flex items-center gap-xs bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">
                                <span className="material-symbols-outlined text-[12px]">folder</span>
                                {a.project.name}
                              </span>
                            ) : (
                              <span className="text-label-sm text-on-surface-variant">Chưa gán project</span>
                            )}
                            {a.lastSyncAt && (
                              <span className="text-label-sm text-on-surface-variant flex items-center gap-xs">
                                <span className="material-symbols-outlined text-[12px]">schedule</span>
                                {new Date(a.lastSyncAt).toLocaleString('en-US')}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-sm flex-shrink-0">
                          <button
                            onClick={() => syncAccount(a.id)}
                            disabled={startingSync !== null || isMetaBillingSyncActive(syncJob)}
                            className="flex items-center gap-xs border border-secondary text-secondary px-md py-xs rounded-lg text-label-sm hover:bg-secondary/5 disabled:opacity-50 transition-colors"
                          >
                            <span className={`material-symbols-outlined text-[14px] ${startingSync === a.id || isMetaBillingSyncActive(syncJob) ? 'animate-spin' : ''}`}>sync</span>
                            {startingSync === a.id ? 'Đang khởi tạo...' : isMetaBillingSyncActive(syncJob) ? 'Đang sync...' : 'Sync billing'}
                          </button>
                          <button
                            onClick={() => deleteAccount(a.id)}
                            disabled={isMetaBillingSyncActive(syncJob)}
                            title={isMetaBillingSyncActive(syncJob) ? 'Chờ billing sync hoàn tất trước khi xóa tài khoản' : 'Xóa tài khoản'}
                            className="text-error/60 hover:text-error disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                          >
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      </div>
                      <div className="mt-md grid grid-cols-1 sm:grid-cols-[120px_auto] gap-sm items-end rounded-lg bg-surface-container-low p-md">
                        <div className="space-y-xs">
                          <label className="block text-label-sm text-on-surface-variant">Tiền tệ</label>
                          <select
                            value={currencyDrafts[a.id] || 'USD'}
                            onChange={e => setCurrencyDrafts(current => ({ ...current, [a.id]: e.target.value }))}
                            className={inputCls}
                          >
                            <option value="USD">USD</option>
                            <option value="VND">VND</option>
                          </select>
                        </div>
                        <button
                          onClick={() => saveCurrency(a)}
                          disabled={savingCurrency === a.id}
                          className="h-[42px] flex items-center justify-center gap-xs bg-secondary text-on-secondary px-md rounded-lg text-label-sm hover:opacity-90 disabled:opacity-50"
                        >
                          <span className={`material-symbols-outlined text-[16px] ${savingCurrency === a.id ? 'animate-spin' : ''}`}>
                            {savingCurrency === a.id ? 'sync' : 'currency_exchange'}
                          </span>
                          Lưu tiền tệ
                        </button>
                      </div>
                      <div className="mt-sm grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-sm items-end rounded-lg border border-outline-variant/20 p-md">
                        <div className="space-y-xs">
                          <label className="block text-label-sm text-on-surface-variant">Access Token mới</label>
                          <div className="relative">
                            <input
                              type={showToken[a.id] ? 'text' : 'password'}
                              value={tokenDrafts[a.id] || ''}
                              onChange={e => setTokenDrafts(current => ({ ...current, [a.id]: e.target.value }))}
                              placeholder="Dán token mới vào đây..."
                              autoComplete="off"
                              className={`${inputCls} pr-10`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowToken(current => ({ ...current, [a.id]: !current[a.id] }))}
                              className="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[20px]">{showToken[a.id] ? 'visibility_off' : 'visibility'}</span>
                            </button>
                          </div>
                        </div>
                        <button
                          onClick={() => updateAccessToken(a)}
                          disabled={updatingToken === a.id || !tokenDrafts[a.id]?.trim()}
                          className="h-[42px] flex items-center justify-center gap-xs bg-primary text-on-primary px-md rounded-lg text-label-sm hover:opacity-90 disabled:opacity-40"
                        >
                          <span className={`material-symbols-outlined text-[16px] ${updatingToken === a.id ? 'animate-spin' : ''}`}>
                            {updatingToken === a.id ? 'sync' : 'key'}
                          </span>
                          Cập nhật token
                        </button>
                      </div>
                      {isAdmin && (
                        <div className="mt-sm flex flex-wrap items-center gap-sm rounded-lg border border-amber-300/50 bg-amber-50/50 p-md">
                          <div className="flex-1 min-w-0">
                            <p className="text-label-sm font-medium text-amber-900">Backfill lịch sử Ad Spend</p>
                            <p className="text-label-sm text-on-surface-variant">
                              {a.project
                                ? `Kéo toàn bộ insights từ ngày bắt đầu project "${a.project.name}" đến hôm nay. Chỉ Admin.`
                                : 'Account chưa gán project — sẽ kéo lịch sử mặc định (tối đa ~2 năm gần nhất). Chỉ Admin.'}
                            </p>
                          </div>
                          <button
                            onClick={() => backfillInsights(a)}
                            disabled={backfilling !== null || isMetaBillingSyncActive(syncJob)}
                            title={isMetaBillingSyncActive(syncJob) ? 'Chờ Meta billing sync hoàn tất' : 'Kéo lại toàn bộ lịch sử insights từ ngày bắt đầu project'}
                            className="h-[42px] flex items-center justify-center gap-xs bg-amber-600 text-white px-lg rounded-lg text-label-sm hover:opacity-90 disabled:opacity-50"
                          >
                            <span className={`material-symbols-outlined text-[16px] ${backfilling === a.id ? 'animate-spin' : ''}`}>
                              {backfilling === a.id ? 'sync' : 'history'}
                            </span>
                            {backfilling === a.id ? 'Đang backfill...' : 'Backfill lịch sử'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

        </div>
      </main>
    </div>
  )
}
