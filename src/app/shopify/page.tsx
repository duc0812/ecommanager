'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import type { ShopifyPayout, ShopifyBankAccount } from '@/lib/shopify'

type Stats = {
  total_payouts: number
  total_paid: number
  total_amount_paid: string
  currency: string
  date_range: { from: string; to: string } | null
}

type BankSummaryItem = {
  bank: ShopifyBankAccount | null
  total: number
  count: number
  currency: string
}

type ApiResponse = {
  stats: Stats
  balance: { currency: string | null; amount: string | null; error?: string }
  bankAccounts: ShopifyBankAccount[]
  bankAccountsError?: string | null
  bankSummary: BankSummaryItem[]
  payouts: ShopifyPayout[]
  error?: string
}

type TxnResponse = {
  payout_id: string
  total: number
  byType: Record<string, number>
  bySourceType: Record<string, number>
  transactions: any[]
  error?: string
}

const STATUS_CHIP: Record<string, string> = {
  paid: 'bg-on-tertiary-container/15 text-on-tertiary-container',
  in_transit: 'bg-secondary/10 text-secondary',
  scheduled: 'bg-amber-100 text-amber-700',
  failed: 'bg-error-container text-on-error-container',
  canceled: 'bg-surface-container text-on-surface-variant',
}

const LS_KEY = 'shopify_credentials_v1'

type Creds = { shop: string; token: string; version: string }

function StatCard({ label, value, icon, accent }: { label: string; value: string; icon: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-lg shadow-card border border-outline-variant/20 ${accent ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest'}`}>
      <div className="flex items-center justify-between mb-sm">
        <span className={`text-label-sm uppercase tracking-wider ${accent ? 'text-on-primary/60' : 'text-on-surface-variant'}`}>{label}</span>
        <span className={`material-symbols-outlined text-[18px] ${accent ? 'text-on-primary/40' : 'text-secondary'}`}>{icon}</span>
      </div>
      <div className={`text-stats-lg font-bold ${accent ? 'text-on-primary' : 'text-primary'}`}>{value}</div>
    </div>
  )
}

export default function FinancePage() {
  const [oauthConnected, setOauthConnected] = useState<{ connected: boolean; shop?: string } | null>(null)
  const [creds, setCreds] = useState<Creds>({ shop: '', token: '', version: '2024-04' })
  const [credsSaved, setCredsSaved] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [dateMin, setDateMin] = useState('')
  const [dateMax, setDateMax] = useState('')
  const [data, setData] = useState<ApiResponse | null>(null)
  const [txnData, setTxnData] = useState<TxnResponse | null>(null)
  const [selectedPayout, setSelectedPayout] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [txnLoading, setTxnLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ synced_payouts?: number; synced_bank_accounts?: number; error?: string } | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null)
  const [fromDB, setFromDB] = useState(false)

  async function loadFromDB() {
    const res = await fetch('/api/shopify/db-payouts')
    const json = await res.json()
    if (!json.empty) {
      setData(json)
      setFromDB(true)
      if (json.lastSyncAt) setLastSyncAt(json.lastSyncAt)
    } else {
      if (json.lastSyncAt) setLastSyncAt(json.lastSyncAt)
    }
  }

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(d => setOauthConnected(d.shopify)).catch(() => {})
    loadFromDB()
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        setCreds({ shop: parsed.shop || '', token: parsed.token || '', version: parsed.version || '2024-04' })
        if (parsed.shop && parsed.token) setCredsSaved(true)
      }
    } catch {}
  }, [])

  const usingOAuth = !!oauthConnected?.connected

  function manualHeaders(): HeadersInit {
    return {
      'x-shopify-shop-domain': creds.shop.trim(),
      'x-shopify-access-token': creds.token.trim(),
      'x-shopify-api-version': (creds.version || '2024-04').trim(),
    }
  }

  function canFetch() { return usingOAuth || !!(creds.shop.trim() && creds.token.trim()) }

  async function fetchPayouts() {
    setLoading(true)
    setData(null)
    setTxnData(null)
    setSyncResult(null)
    setFromDB(false)
    const params = new URLSearchParams()
    if (dateMin) params.set('date_min', dateMin)
    if (dateMax) params.set('date_max', dateMax)
    try {
      const res = await fetch(`/api/shopify/payouts?${params}`, { headers: usingOAuth ? {} : manualHeaders() })
      setData(await res.json())
    } catch (e: any) {
      setData({ error: e?.message || 'Network error' } as any)
    }
    setLoading(false)
  }

  async function syncToDB() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/shopify/sync', { method: 'POST', headers: usingOAuth ? {} : manualHeaders() })
      const result = await res.json()
      setSyncResult(result)
      if (!result.error) await loadFromDB()
    } catch (e: any) {
      setSyncResult({ error: e?.message })
    }
    setSyncing(false)
  }

  async function fetchTransactions(payoutId: number) {
    setTxnLoading(true)
    setSelectedPayout(payoutId)
    try {
      const res = await fetch(`/api/shopify/payouts/${payoutId}`, { headers: usingOAuth ? {} : manualHeaders() })
      setTxnData(await res.json())
    } catch (e: any) {
      setTxnData({ error: e?.message } as any)
    }
    setTxnLoading(false)
  }

  const shopName = oauthConnected?.shop ?? creds.shop ?? 'Your Store'

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />

      <main className="ml-[280px] flex-1 p-xl">
        {/* Header */}
        <header className="flex items-start justify-between mb-xl">
          <div>
            <h2 className="text-display-md font-bold text-primary">Finance</h2>
            <p className="text-on-surface-variant text-body-md mt-xs">
              <span className="inline-flex items-center gap-sm flex-wrap">
                {usingOAuth ? (
                  <span className="inline-flex items-center gap-xs">
                    <span className="w-2 h-2 rounded-full bg-on-tertiary-container animate-pulse inline-block"></span>
                    Đã kết nối: <strong>{shopName}</strong>
                  </span>
                ) : 'Shopify Payments — Payout & Cashflow Analysis'}
                {lastSyncAt && (
                  <span className="inline-flex items-center gap-xs text-label-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-[14px]">schedule</span>
                    Last synced: {new Date(lastSyncAt).toLocaleString('vi-VN')}
                  </span>
                )}
              </span>
            </p>
          </div>
          <div className="flex gap-sm items-center">
            {data && !data.error && (
              <button
                onClick={syncToDB}
                disabled={syncing}
                className="flex items-center gap-sm border border-secondary text-secondary px-lg py-sm rounded-lg text-label-md hover:bg-secondary/5 transition-colors disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[18px] ${syncing ? 'animate-spin' : ''}`}>
                  {syncing ? 'sync' : 'save'}
                </span>
                {syncing ? 'Saving...' : 'Save to DB'}
              </button>
            )}
            <button
              onClick={fetchPayouts}
              disabled={loading || !canFetch()}
              className="flex items-center gap-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[18px] ${loading ? 'animate-spin' : ''}`}>
                {loading ? 'sync' : 'download'}
              </span>
              {loading ? 'Fetching...' : 'Fetch Payouts'}
            </button>
          </div>
        </header>

        {/* Connection alert */}
        {oauthConnected?.connected === false && !credsSaved && (
          <div className="mb-xl bg-amber-50 border border-amber-200 rounded-xl px-lg py-md flex items-center gap-md">
            <span className="material-symbols-outlined text-amber-600">warning</span>
            <div className="flex-1">
              <p className="text-label-md text-amber-800">Chưa kết nối Shopify</p>
              <p className="text-body-sm text-amber-700">Kết nối OAuth hoặc nhập credentials thủ công bên dưới.</p>
            </div>
            <a href="/setup" className="bg-amber-600 text-white px-md py-sm rounded-lg text-label-md hover:bg-amber-700 transition-colors">
              Setup OAuth
            </a>
          </div>
        )}

        {/* Sync result */}
        {syncResult && (
          <div className={`mb-xl rounded-xl px-lg py-md flex items-center gap-md ${syncResult.error ? 'bg-error-container/20 border border-error/20' : 'bg-on-tertiary-container/10 border border-on-tertiary-container/20'}`}>
            <span className={`material-symbols-outlined ${syncResult.error ? 'text-error' : 'text-on-tertiary-container'}`}>
              {syncResult.error ? 'error' : 'check_circle'}
            </span>
            <p className="text-body-sm">
              {syncResult.error
                ? `Lỗi sync: ${syncResult.error}`
                : `Đã lưu ${syncResult.synced_payouts} payouts và ${syncResult.synced_bank_accounts} bank accounts vào database.`}
            </p>
          </div>
        )}

        {/* Manual credentials — hidden when OAuth connected */}
        {!usingOAuth && (
          <div className="mb-xl bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
            <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
              <span className="material-symbols-outlined text-secondary">key</span>
              <h3 className="text-headline-sm text-primary">Shopify Credentials</h3>
              {credsSaved && <span className="ml-auto bg-on-tertiary-container/15 text-on-tertiary-container px-sm py-xs rounded-full text-label-sm">✓ Saved</span>}
            </div>
            <div className="p-lg">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-lg mb-lg">
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Shop domain</label>
                  <input
                    type="text"
                    value={creds.shop}
                    onChange={e => setCreds({ ...creds, shop: e.target.value })}
                    placeholder="your-store.myshopify.com"
                    className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                  />
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">Access token</label>
                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={creds.token}
                      onChange={e => setCreds({ ...creds, token: e.target.value })}
                      placeholder="shpat_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm pr-10 text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(s => !s)}
                      className="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-[20px]">{showToken ? 'visibility_off' : 'visibility'}</span>
                    </button>
                  </div>
                </div>
                <div className="space-y-xs">
                  <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">API version</label>
                  <input
                    type="text"
                    value={creds.version}
                    onChange={e => setCreds({ ...creds, version: e.target.value })}
                    placeholder="2024-04"
                    className="w-full bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-sm">
                <button
                  onClick={() => { try { localStorage.setItem(LS_KEY, JSON.stringify(creds)); setCredsSaved(true) } catch {} }}
                  disabled={!(creds.shop.trim() && creds.token.trim())}
                  className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Save credentials
                </button>
                <button
                  onClick={() => { localStorage.removeItem(LS_KEY); setCreds({ shop: '', token: '', version: '2024-04' }); setCredsSaved(false); setData(null) }}
                  className="border border-outline-variant text-on-surface-variant px-lg py-sm rounded-lg text-label-md hover:bg-surface-container transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Date filter */}
        <div className="mb-xl bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
          <div className="flex flex-wrap gap-lg items-end">
            <div className="space-y-xs">
              <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">From date</label>
              <input
                type="date"
                value={dateMin}
                onChange={e => setDateMin(e.target.value)}
                className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary outline-none"
              />
            </div>
            <div className="space-y-xs">
              <label className="block text-label-sm text-on-surface-variant uppercase tracking-wider">To date</label>
              <input
                type="date"
                value={dateMax}
                onChange={e => setDateMax(e.target.value)}
                className="bg-surface-container border border-outline-variant/30 rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-secondary outline-none"
              />
            </div>
            <button
              onClick={() => { setDateMin(''); setDateMax('') }}
              className="border border-outline-variant text-on-surface-variant px-lg py-sm rounded-lg text-label-md hover:bg-surface-container transition-colors"
            >
              Clear filter
            </button>
            {!canFetch() && (
              <span className="text-label-sm text-amber-600 self-center flex items-center gap-xs">
                <span className="material-symbols-outlined text-[16px]">warning</span>
                Nhập credentials trước
              </span>
            )}
          </div>
        </div>

        {/* Error */}
        {data?.error && (
          <div className="mb-xl bg-error-container/20 border border-error/20 rounded-xl px-lg py-md flex items-center gap-md">
            <span className="material-symbols-outlined text-error">error</span>
            <p className="text-body-sm text-on-error-container">{data.error}</p>
          </div>
        )}

        {/* Stats + Data */}
        {data && !data.error && (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-lg mb-xl">
              <StatCard label="Total Payouts" value={String(data.stats.total_payouts)} icon="receipt_long" />
              <StatCard label="Paid" value={String(data.stats.total_paid)} icon="check_circle" />
              <StatCard label="Total Paid" value={`${data.stats.total_amount_paid} ${data.stats.currency}`} icon="account_balance_wallet" accent />
              <StatCard
                label="Current Balance"
                value={data.balance?.amount ? `${data.balance.amount} ${data.balance.currency}` : '—'}
                icon="savings"
              />
            </div>

            {data.stats.date_range && (
              <p className="text-label-sm text-on-surface-variant mb-xl">
                Khoảng thời gian: {data.stats.date_range.from} → {data.stats.date_range.to}
              </p>
            )}

            {/* Bank summary */}
            <div className="mb-xl bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">account_balance</span>
                <h3 className="text-headline-sm text-primary">Payout by Bank Account</h3>
                {data.bankAccountsError && (
                  <span className="ml-auto bg-amber-100 text-amber-700 px-sm py-xs rounded-full text-label-sm">
                    ⚠ {data.bankAccountsError}
                  </span>
                )}
              </div>
              {data.bankSummary?.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-outline-variant/20 bg-surface-container-low">
                        {['Bank', 'Account', 'Country', 'Currency', 'Payouts', 'Total received', 'Status'].map(h => (
                          <th key={h} className="text-left px-lg py-md text-label-md text-on-surface-variant">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.bankSummary.map((item, i) => (
                        <tr key={i} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors">
                          <td className="px-lg py-md text-label-md text-primary">{item.bank?.bank_name || '—'}</td>
                          <td className="px-lg py-md text-body-sm font-mono text-on-surface-variant">{item.bank?.account_number || 'unknown'}</td>
                          <td className="px-lg py-md text-body-sm">{item.bank?.country || '—'}</td>
                          <td className="px-lg py-md text-body-sm">{item.currency}</td>
                          <td className="px-lg py-md text-label-md text-center">{item.count}</td>
                          <td className="px-lg py-md text-label-md text-on-tertiary-container font-bold">{item.total.toFixed(2)} {item.currency}</td>
                          <td className="px-lg py-md">
                            {item.bank ? (
                              <span className={`px-sm py-xs rounded-full text-label-sm ${item.bank.verified ? 'bg-on-tertiary-container/15 text-on-tertiary-container' : 'bg-amber-100 text-amber-700'}`}>
                                {item.bank.verified ? 'Verified' : 'Unverified'}
                              </span>
                            ) : <span className="text-on-surface-variant">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-lg py-xl text-center text-on-surface-variant text-body-sm">
                  No bank data — fetch payouts to see payout summary by bank.
                </div>
              )}
            </div>

            {/* Payouts table */}
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden mb-xl">
              <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                <span className="material-symbols-outlined text-secondary">payments</span>
                <h3 className="text-headline-sm text-primary">Payouts</h3>
                {fromDB && (
                  <span className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm flex items-center gap-xs">
                    <span className="material-symbols-outlined text-[12px]">database</span>
                    từ database
                  </span>
                )}
                <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">
                  {data.payouts.length} records
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-outline-variant/20 bg-surface-container-low">
                      {['Date', 'Status', 'Amount', 'Bank', 'Gross Revenue', 'Shopify Fee', 'Refunds', ''].map(h => (
                        <th key={h} className="text-left px-lg py-md text-label-md text-on-surface-variant">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map(p => (
                      <tr
                        key={p.id}
                        className={`border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors ${selectedPayout === p.id ? 'bg-secondary/5' : ''}`}
                      >
                        <td className="px-lg py-sm text-body-sm text-on-surface-variant">{p.date}</td>
                        <td className="px-lg py-sm">
                          <span className={`px-sm py-xs rounded-full text-label-sm ${STATUS_CHIP[p.status] ?? 'bg-surface-container text-on-surface-variant'}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="px-lg py-sm text-label-md text-on-tertiary-container font-bold">{p.amount} {p.currency}</td>
                        <td className="px-lg py-sm text-body-sm text-on-surface-variant">
                          {(() => {
                            const ba = data.bankAccounts?.find(b => b.id === p.bank_account_id)
                            return ba ? `${ba.bank_name} ${ba.account_number}` : (p.bank_account_id ? `#${p.bank_account_id}` : '—')
                          })()}
                        </td>
                        <td className="px-lg py-sm text-body-sm">{p.summary.charges_gross_amount}</td>
                        <td className="px-lg py-sm text-body-sm text-error">-{p.summary.charges_fee_amount}</td>
                        <td className="px-lg py-sm text-body-sm text-error">{p.summary.refunds_gross_amount}</td>
                        <td className="px-lg py-sm">
                          <button
                            onClick={() => fetchTransactions(p.id)}
                            className="text-secondary text-label-sm hover:underline flex items-center gap-xs"
                          >
                            {txnLoading && selectedPayout === p.id ? (
                              <span className="material-symbols-outlined text-[14px] animate-spin">sync</span>
                            ) : (
                              <span className="material-symbols-outlined text-[14px]">chevron_right</span>
                            )}
                            Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* Payout transactions */}
        {txnData?.error && (
          <div className="mb-xl bg-error-container/20 border border-error/20 rounded-xl px-lg py-md flex items-center gap-md">
            <span className="material-symbols-outlined text-error">error</span>
            <p className="text-body-sm">{txnData.error}</p>
          </div>
        )}

        {txnData && !txnData.error && (
          <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden mb-xl">
            <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
              <span className="material-symbols-outlined text-secondary">receipt</span>
              <h3 className="text-headline-sm text-primary">Payout #{txnData.payout_id} — Transactions</h3>
              <span className="ml-auto bg-surface-container-high px-sm py-xs rounded text-label-sm text-on-surface-variant">
                {txnData.total} transactions
              </span>
            </div>

            <div className="flex gap-xl px-lg py-md border-b border-outline-variant/10 flex-wrap">
              <div>
                <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">By type</p>
                <div className="flex flex-wrap gap-xs">
                  {Object.entries(txnData.byType).map(([type, count]) => (
                    <span key={type} className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">
                      {type}: {count}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">By source</p>
                <div className="flex flex-wrap gap-xs">
                  {Object.entries(txnData.bySourceType).map(([type, count]) => (
                    <span key={type} className="bg-surface-container text-on-surface-variant px-sm py-xs rounded-full text-label-sm">
                      {type}: {count}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-outline-variant/20 bg-surface-container-low">
                    {['Type', 'Source type', 'Amount', 'Fee', 'Net', 'Processed at', 'Order ID'].map(h => (
                      <th key={h} className="text-left px-lg py-md text-label-md text-on-surface-variant">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {txnData.transactions.map((t: any) => (
                    <tr key={t.id} className="border-b border-outline-variant/10 hover:bg-surface-container-low/50 transition-colors">
                      <td className="px-lg py-sm">
                        <span className="bg-secondary/10 text-secondary px-sm py-xs rounded-full text-label-sm">{t.type}</span>
                      </td>
                      <td className="px-lg py-sm text-body-sm text-on-surface-variant">{t.source_type}</td>
                      <td className={`px-lg py-sm text-label-md font-bold ${parseFloat(t.amount) >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                        {t.amount}
                      </td>
                      <td className="px-lg py-sm text-body-sm text-error">{t.fee}</td>
                      <td className={`px-lg py-sm text-label-md font-bold ${parseFloat(t.net) >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                        {t.net}
                      </td>
                      <td className="px-lg py-sm text-body-sm text-on-surface-variant">
                        {new Date(t.processed_at).toLocaleDateString('vi-VN')}
                      </td>
                      <td className="px-lg py-sm text-body-sm text-on-surface-variant font-mono">{t.source_order_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!data && !loading && (
          <div className="flex flex-col items-center justify-center py-3xl text-center">
            <div className="w-16 h-16 bg-secondary/10 rounded-2xl flex items-center justify-center mb-lg">
              <span className="material-symbols-outlined text-[40px] text-secondary">payments</span>
            </div>
            <h3 className="text-headline-sm text-primary mb-sm">No data yet</h3>
            <p className="text-body-md text-on-surface-variant max-w-sm">
              Click <strong>Fetch Payouts</strong> to load your Shopify Payments data.
              {!canFetch() && ' Connect OAuth on the Setup page first.'}
            </p>
            {!canFetch() && (
              <a href="/setup" className="mt-lg bg-secondary text-on-secondary px-xl py-md rounded-lg text-label-md hover:opacity-90 transition-opacity">
                Go to Setup
              </a>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
