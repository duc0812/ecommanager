'use client'
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type MetaAccount = {
  id: string
  accountId: string
  accountName: string | null
  projectId: string | null
  project: { name: string } | null
  lastSyncAt: string | null
}

type MetaBilling = {
  id: string
  adAccountId: string
  amount: number
  currency: string
  billingDate: string
  status: string
  chargeType: string | null
  productType: string | null
  paymentMethod: string | null
  paymentMethodLast4: string | null
  referenceNumber: string | null
  receiptUrl: string | null
  adAccount: { accountId: string; accountName: string | null }
  projectLabel: { id: string; name: string } | null
  staffLabels: { id: string; name: string; role: string | null }[]
}

type DBData = {
  accounts: MetaAccount[]
  billings: MetaBilling[]
  totalSpent: number
  totalPending: number
  count: number
  paidCount: number
  failedCount: number
  pendingCount: number
  avgSpend: number
  lastSyncAt: string | null
  empty?: boolean
}

type ImportResult = {
  rows: number
  imported: number
  updated: number
  skipped: number
  errors: { row: number; error: string }[]
  error?: string
}

function fmtUSD(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}

function fmt(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function statusClass(status: string) {
  if (status === 'PAID' || status === 'SETTLED' || status === 'COMPLETED') {
    return 'bg-on-tertiary-container/15 text-on-tertiary-container'
  }
  if (status === 'FAILED') return 'bg-error/15 text-error'
  if (status === 'PENDING') return 'bg-amber-100 text-amber-900'
  return 'bg-surface-container text-on-surface-variant'
}

function statusLabel(status: string) {
  if (status === 'PAID' || status === 'SETTLED' || status === 'COMPLETED') return 'Paid'
  if (status === 'FAILED') return 'Failed'
  if (status === 'PENDING') return 'Pending'
  return status
}

function paymentMethodLabel(billing: MetaBilling) {
  const method = billing.paymentMethod || billing.chargeType || '-'
  if (!billing.paymentMethodLast4) return method
  return `${method} **** ${billing.paymentMethodLast4}`
}

function monthLabel(month: string) {
  if (!month) return 'All time'
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export default function MetaBillingPage() {
  const [data, setData] = useState<DBData | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [selectedMonth, setSelectedMonth] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ synced?: number; insightsDays?: number; error?: string } | null>(null)
  const [importAccountId, setImportAccountId] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const accounts = useMemo(() => data?.accounts ?? [], [data?.accounts])

  const load = useCallback(async (accountId?: string, month?: string) => {
    setLoading(true)
    const params = new URLSearchParams()
    if (accountId && accountId !== 'all') params.set('accountId', accountId)
    if (month) params.set('month', month)
    const query = params.toString()
    const res = await fetch(`/api/meta/db-billing${query ? `?${query}` : ''}`)
    const json = await res.json()
    setData(json)
    setLoading(false)
  }, [])

  useEffect(() => { load(selectedAccount, selectedMonth) }, [load, selectedAccount, selectedMonth])

  useEffect(() => {
    if (selectedAccount !== 'all') setImportAccountId(selectedAccount)
    else if (!importAccountId && accounts.length > 0) setImportAccountId(accounts[0].id)
  }, [accounts, importAccountId, selectedAccount])

  async function syncAll() {
    setSyncing(true)
    setSyncResult(null)
    const [billingRes, insightsRes] = await Promise.all([
      fetch('/api/meta/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      fetch('/api/meta/sync-insights', { method: 'POST' }),
    ])
    const billing = await billingRes.json()
    const insights = await insightsRes.json().catch(() => ({}))
    const error = billing.error ?? insights.error
    setSyncResult(error ? { error } : { synced: billing.synced, insightsDays: insights.synced })
    if (!error) await load(selectedAccount, selectedMonth)
    setSyncing(false)
  }

  function handleAccountFilter(val: string) {
    setSelectedAccount(val)
  }

  function handleMonthFilter(val: string) {
    setSelectedMonth(val)
  }

  async function importBillingFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !importAccountId) return

    setImporting(true)
    setImportResult(null)
    const form = new FormData()
    form.set('accountId', importAccountId)
    form.set('file', file)

    const res = await fetch('/api/meta/import', { method: 'POST', body: form })
    const json = await res.json()
    setImportResult(json)
    if (!json.error) await load(selectedAccount, selectedMonth)
    setImporting(false)
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <header className="flex items-start justify-between mb-xl">
          <div>
            <h2 className="text-display-md font-bold text-primary">Meta Transactions</h2>
            <p className="text-on-surface-variant text-body-md mt-xs flex items-center gap-sm flex-wrap">
              <span>Payment attempts from Meta billing</span>
              {data?.lastSyncAt && (
                <span className="inline-flex items-center gap-xs text-label-sm">
                  <span className="material-symbols-outlined text-[14px]">schedule</span>
                  Last synced: {new Date(data.lastSyncAt).toLocaleString('vi-VN')}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={syncAll}
            disabled={syncing || accounts.length === 0}
            className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${syncing ? 'animate-spin' : ''}`}>
              {syncing ? 'sync' : 'download'}
            </span>
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </header>

        {syncResult && (
          <div className={`mb-lg rounded-xl px-lg py-md flex items-center gap-md ${syncResult.error ? 'bg-error-container/20 border border-error/20' : 'bg-on-tertiary-container/10 border border-on-tertiary-container/20'}`}>
            <span className={`material-symbols-outlined ${syncResult.error ? 'text-error' : 'text-on-tertiary-container'}`}>
              {syncResult.error ? 'error' : 'check_circle'}
            </span>
            <p className="text-body-sm">
              {syncResult.error ? `Error: ${syncResult.error}` : `Synced ${syncResult.synced} transactions.`}
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-[120px]">
            <span className="material-symbols-outlined animate-spin text-[32px] text-secondary">sync</span>
          </div>
        ) : !data || data.empty || accounts.length === 0 ? (
          <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-xl text-center">
            <span className="material-symbols-outlined text-[48px] text-on-surface-variant/30">campaign</span>
            <p className="text-on-surface-variant mt-md text-body-md">No ad accounts connected.</p>
            <a href="/setup/meta" className="inline-flex items-center gap-sm mt-lg bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90">
              <span className="material-symbols-outlined text-[16px]">add_circle</span>
              Add Ad Account
            </a>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-md mb-lg flex-wrap">
              <div className="flex items-center gap-sm">
                <span className="material-symbols-outlined text-[16px] text-on-surface-variant">filter_alt</span>
                <span className="text-label-sm text-on-surface-variant">Ad Account:</span>
              </div>
              <div className="flex gap-xs flex-wrap">
                <button
                  onClick={() => handleAccountFilter('all')}
                  className={`px-md py-xs rounded-lg text-label-sm transition-all ${selectedAccount === 'all' ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
                >
                  All
                </button>
                {accounts.map(a => (
                  <button
                    key={a.id}
                    onClick={() => handleAccountFilter(a.id)}
                    className={`flex items-center gap-xs px-md py-xs rounded-lg text-label-sm transition-all ${selectedAccount === a.id ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
                  >
                    {a.accountName || a.accountId}
                    {a.project && <span className="opacity-70">- {a.project.name}</span>}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-sm ml-auto">
                <span className="text-label-sm text-on-surface-variant">Month:</span>
                <input
                  type="month"
                  value={selectedMonth}
                  onChange={e => handleMonthFilter(e.target.value)}
                  className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-xs text-body-sm focus:ring-2 focus:ring-secondary outline-none"
                />
                {selectedMonth && (
                  <button
                    onClick={() => handleMonthFilter('')}
                    className="bg-surface-container text-on-surface-variant hover:bg-surface-container-high rounded-lg px-md py-xs text-label-sm"
                  >
                    All time
                  </button>
                )}
                <span className="text-label-sm text-on-surface-variant">{monthLabel(selectedMonth)}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-lg mb-xl">
              <div className="bg-primary rounded-xl p-lg border border-outline-variant/20">
                <div className="flex items-center gap-sm mb-sm">
                  <span className="material-symbols-outlined text-[18px] text-on-primary/50">payments</span>
                  <span className="text-label-sm text-on-primary/60 uppercase tracking-wider">Paid Amount</span>
                </div>
                <p className="text-stats-lg font-bold text-on-primary">{fmtUSD(data.totalSpent)}</p>
                <p className="text-label-sm text-on-primary/50 mt-xs">{data.paidCount ?? 0} paid transactions</p>
              </div>
              {(data.pendingCount ?? 0) > 0 && (
                <div className="bg-amber-50 rounded-xl p-lg border border-amber-200">
                  <div className="flex items-center gap-sm mb-sm">
                    <span className="material-symbols-outlined text-[18px] text-amber-600">pending</span>
                    <span className="text-label-sm text-amber-700 uppercase tracking-wider">Pending</span>
                  </div>
                  <p className="text-stats-lg font-bold text-amber-900">{fmtUSD(data.totalPending ?? 0)}</p>
                  <p className="text-label-sm text-amber-700 mt-xs">{data.pendingCount} pending transactions</p>
                </div>
              )}
              <div className="bg-surface-container-lowest rounded-xl p-lg border border-outline-variant/20">
                <div className="flex items-center gap-sm mb-sm">
                  <span className="material-symbols-outlined text-[18px] text-secondary">receipt_long</span>
                  <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">Transactions</span>
                </div>
                <p className="text-stats-lg font-bold text-primary">{data.count}</p>
                <p className="text-label-sm text-on-surface-variant mt-xs">all payment attempts</p>
              </div>
              <div className="bg-surface-container-lowest rounded-xl p-lg border border-outline-variant/20">
                <div className="flex items-center gap-sm mb-sm">
                  <span className="material-symbols-outlined text-[18px] text-secondary">error</span>
                  <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">Failed</span>
                </div>
                <p className="text-stats-lg font-bold text-primary">{data.failedCount ?? 0}</p>
                <p className="text-label-sm text-on-surface-variant mt-xs">failed payment attempts</p>
              </div>
            </div>

            <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg">
              <div className="flex flex-wrap items-center gap-md">
                <div>
                  <h3 className="text-headline-sm text-primary">Import Meta Billing Export</h3>
                  <p className="mt-xs text-body-sm text-on-surface-variant">
                    Upload CSV/XLSX from Meta Billing UI. Paid and pending rows are upserted by Transaction ID; failed/declined rows are skipped.
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-sm">
                  <select
                    value={importAccountId}
                    onChange={e => setImportAccountId(e.target.value)}
                    className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-sm outline-none"
                  >
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.accountName || a.accountId}</option>
                    ))}
                  </select>
                  <label className={`inline-flex cursor-pointer items-center gap-sm rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary shadow-sm hover:opacity-90 ${importing ? 'pointer-events-none opacity-60' : ''}`}>
                    <span className={`material-symbols-outlined text-[18px] ${importing ? 'animate-spin' : ''}`}>{importing ? 'sync' : 'upload_file'}</span>
                    {importing ? 'Importing...' : 'Upload CSV/XLSX'}
                    <input type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={importBillingFile} className="hidden" disabled={importing || !importAccountId} />
                  </label>
                </div>
              </div>
              {importResult && (
                <div className={`mt-md rounded-lg px-md py-sm text-body-sm ${importResult.error ? 'bg-error-container/20 text-error' : 'bg-on-tertiary-container/10 text-on-tertiary-container'}`}>
                  {importResult.error ? (
                    <span>Error: {importResult.error}</span>
                  ) : (
                    <span>
                      {importResult.rows} rows processed — {importResult.imported} imported, {importResult.updated} updated, {importResult.skipped} skipped (failed/empty), {importResult.errors?.length ?? 0} errors.
                    </span>
                  )}
                  {!importResult.error && importResult.errors?.length > 0 && (
                    <div className="mt-xs text-error">
                      {importResult.errors.slice(0, 5).map(err => <div key={`${err.row}-${err.error}`}>Row {err.row}: {err.error}</div>)}
                    </div>
                  )}
                </div>
              )}
            </section>

            <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">table_chart</span>
                <h3 className="text-headline-sm text-primary">Billing Transactions</h3>
                <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm flex items-center gap-xs ml-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-on-tertiary-container inline-block"></span>
                  Paid + Pending
                </span>
                <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">{data.count}</span>
              </div>
              {data.billings.length === 0 ? (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
                  No transactions yet. Click <strong>Sync Now</strong> to fetch from Meta.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/20 bg-surface-container-low/40">
                        {['Transaction ID', 'Date', 'Amount', 'Labels', 'Payment method', 'Reference number', 'Payment status', 'Action'].map(h => (
                          <th key={h} className="text-left px-lg py-sm text-label-sm text-on-surface-variant uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/10">
                      {data.billings.map(b => (
                        <tr key={b.id} className="hover:bg-surface-container-low/40 transition-colors">
                          <td className="px-lg py-md text-body-sm text-secondary max-w-[220px] break-all">{b.id}</td>
                          <td className="px-lg py-md text-body-sm text-on-surface">{fmt(b.billingDate)}</td>
                          <td className="px-lg py-md text-label-md font-bold text-primary">{fmtUSD(b.amount)}</td>
                          <td className="px-lg py-md">
                            <div className="flex flex-wrap gap-xs max-w-[260px]">
                              {b.projectLabel && (
                                <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">
                                  {b.projectLabel.name}
                                </span>
                              )}
                              {b.staffLabels.map(staff => (
                                <span key={staff.id} className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">
                                  {staff.name}
                                </span>
                              ))}
                              {!b.projectLabel && b.staffLabels.length === 0 && <span className="text-on-surface-variant">-</span>}
                            </div>
                          </td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">{paymentMethodLabel(b)}</td>
                          <td className="px-lg py-md text-body-sm text-on-surface-variant">{b.referenceNumber || '-'}</td>
                          <td className="px-lg py-md">
                            <span className={`${statusClass(b.status)} px-sm py-xs rounded-full text-label-sm`}>
                              {statusLabel(b.status)}
                            </span>
                          </td>
                          <td className="px-lg py-md">
                            {b.receiptUrl ? (
                              <a href={b.receiptUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center w-9 h-9 rounded border border-outline-variant/60 hover:bg-surface-container">
                                <span className="material-symbols-outlined text-[18px]">download</span>
                              </a>
                            ) : (
                              <span className="text-on-surface-variant">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-outline-variant/30 bg-surface-container-low/20">
                        <td colSpan={2} className="px-lg py-md text-label-md font-semibold text-primary">Paid total</td>
                        <td className="px-lg py-md text-label-md font-bold text-primary">{fmtUSD(data.totalSpent)}</td>
                        <td colSpan={5} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
