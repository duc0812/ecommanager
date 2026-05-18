'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Project = { id: string; name: string }
type MetaAccount = {
  id: string
  accountId: string
  accountName: string | null
  accessToken: string
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
  const [saving, setSaving] = useState(false)

  const [assignId, setAssignId] = useState('')
  const [assignProject, setAssignProject] = useState('')
  const [assigning, setAssigning] = useState(false)

  const [showToken, setShowToken] = useState<Record<string, boolean>>({})
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ ok?: boolean; count?: number; error?: string } | null>(null)

  async function load() {
    setLoading(true)
    const [a, p] = await Promise.all([
      fetch('/api/meta/accounts').then(r => r.json()),
      fetch('/api/projects').then(r => r.json()),
    ])
    setAccounts(Array.isArray(a) ? a : [])
    setProjects(Array.isArray(p) ? p : [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function addAccount() {
    if (!accountId || !accessToken) return
    setSaving(true)
    await fetch('/api/meta/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, accountName, accessToken }),
    })
    setAccountId(''); setAccountName(''); setAccessToken('')
    await load()
    setSaving(false)
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
    setSyncing(id)
    setSyncResult(null)
    const res = await fetch('/api/meta/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: id }),
    })
    const data = await res.json()
    setSyncResult(data.error ? { error: data.error } : { ok: true, count: data.synced })
    setSyncing(null)
    await load()
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
        </header>

        {syncResult && (
          <div className={`mb-lg rounded-xl px-lg py-md flex items-center gap-md ${syncResult.error ? 'bg-error-container/20 border border-error/20' : 'bg-on-tertiary-container/10 border border-on-tertiary-container/20'}`}>
            <span className={`material-symbols-outlined ${syncResult.error ? 'text-error' : 'text-on-tertiary-container'}`}>
              {syncResult.error ? 'error' : 'check_circle'}
            </span>
            <p className="text-body-sm">
              {syncResult.error ? `Lỗi sync: ${syncResult.error}` : `Đã sync ${syncResult.count} billing records.`}
            </p>
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
                                {new Date(a.lastSyncAt).toLocaleString('vi-VN')}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-sm flex-shrink-0">
                          <button
                            onClick={() => syncAccount(a.id)}
                            disabled={syncing === a.id}
                            className="flex items-center gap-xs border border-secondary text-secondary px-md py-xs rounded-lg text-label-sm hover:bg-secondary/5 disabled:opacity-50 transition-colors"
                          >
                            <span className={`material-symbols-outlined text-[14px] ${syncing === a.id ? 'animate-spin' : ''}`}>sync</span>
                            {syncing === a.id ? 'Syncing...' : 'Sync'}
                          </button>
                          <button onClick={() => deleteAccount(a.id)} className="text-error/60 hover:text-error transition-colors">
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      </div>
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
