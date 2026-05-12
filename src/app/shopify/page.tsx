'use client'
import { useState } from 'react'
import type { ShopifyPayout } from '@/lib/shopify'

type Stats = {
  total_payouts: number
  total_paid: number
  total_amount_paid: string
  currency: string
  date_range: { from: string; to: string } | null
}

type ApiResponse = {
  stats: Stats
  balance: { currency: string; amount: string }
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

const STATUS_COLOR: Record<string, string> = {
  paid: 'bg-green-100 text-green-700',
  in_transit: 'bg-blue-100 text-blue-700',
  scheduled: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-700',
  canceled: 'bg-gray-100 text-gray-500',
}

export default function ShopifyDataPage() {
  const [dateMin, setDateMin] = useState('')
  const [dateMax, setDateMax] = useState('')
  const [data, setData] = useState<ApiResponse | null>(null)
  const [txnData, setTxnData] = useState<TxnResponse | null>(null)
  const [selectedPayout, setSelectedPayout] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [txnLoading, setTxnLoading] = useState(false)

  async function fetchPayouts() {
    setLoading(true)
    setData(null)
    setTxnData(null)
    const params = new URLSearchParams()
    if (dateMin) params.set('date_min', dateMin)
    if (dateMax) params.set('date_max', dateMax)
    const res = await fetch(`/api/shopify/payouts?${params}`)
    const json = await res.json()
    setData(json)
    setLoading(false)
  }

  async function fetchTransactions(payoutId: number) {
    setTxnLoading(true)
    setSelectedPayout(payoutId)
    const res = await fetch(`/api/shopify/payouts/${payoutId}`)
    const json = await res.json()
    setTxnData(json)
    setTxnLoading(false)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto font-mono text-sm">
      <h1 className="text-xl font-bold mb-1">Shopify Payments — Raw Data Explorer</h1>
      <p className="text-gray-500 mb-6 text-xs">Dùng để collect và review data thực tế trước khi thiết kế DB schema</p>

      {/* Filter */}
      <div className="flex gap-3 items-end mb-6 flex-wrap">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Date from</label>
          <input type="date" value={dateMin} onChange={e => setDateMin(e.target.value)}
            className="border rounded px-2 py-1 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Date to</label>
          <input type="date" value={dateMax} onChange={e => setDateMax(e.target.value)}
            className="border rounded px-2 py-1 text-sm" />
        </div>
        <button onClick={fetchPayouts} disabled={loading}
          className="bg-indigo-600 text-white px-4 py-1.5 rounded text-sm disabled:opacity-50 hover:bg-indigo-700">
          {loading ? 'Fetching...' : 'Fetch Payouts'}
        </button>
      </div>

      {data?.error && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mb-6 text-red-700">
          <strong>Error:</strong> {data.error}
        </div>
      )}

      {data && !data.error && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Total payouts', value: data.stats.total_payouts },
              { label: 'Paid payouts', value: data.stats.total_paid },
              { label: 'Total paid amount', value: `${data.stats.total_amount_paid} ${data.stats.currency}` },
              { label: 'Current balance', value: `${data.balance.amount} ${data.balance.currency}` },
            ].map(({ label, value }) => (
              <div key={label} className="border rounded p-3 bg-gray-50">
                <div className="text-xs text-gray-500">{label}</div>
                <div className="font-bold text-base mt-0.5">{value}</div>
              </div>
            ))}
          </div>

          {data.stats.date_range && (
            <p className="text-xs text-gray-400 mb-4">
              Date range: {data.stats.date_range.from} → {data.stats.date_range.to}
            </p>
          )}

          {/* Payouts table */}
          <div className="border rounded overflow-auto mb-6">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 border-b">
                <tr>
                  {['ID', 'Date', 'Status', 'Amount', 'Currency', 'Charges gross', 'Charges fee', 'Refunds gross', 'Adj gross', 'Actions'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-gray-600">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.payouts.map(p => (
                  <tr key={p.id} className={`border-b hover:bg-gray-50 ${selectedPayout === p.id ? 'bg-indigo-50' : ''}`}>
                    <td className="px-3 py-1.5 text-gray-400">{p.id}</td>
                    <td className="px-3 py-1.5">{p.date}</td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${STATUS_COLOR[p.status] ?? ''}`}>{p.status}</span>
                    </td>
                    <td className="px-3 py-1.5 font-semibold text-green-700">{p.amount}</td>
                    <td className="px-3 py-1.5">{p.currency}</td>
                    <td className="px-3 py-1.5">{p.summary.charges_gross_amount}</td>
                    <td className="px-3 py-1.5 text-red-600">-{p.summary.charges_fee_amount}</td>
                    <td className="px-3 py-1.5 text-red-500">{p.summary.refunds_gross_amount}</td>
                    <td className="px-3 py-1.5">{p.summary.adjustments_gross_amount}</td>
                    <td className="px-3 py-1.5">
                      <button onClick={() => fetchTransactions(p.id)}
                        className="text-indigo-600 hover:underline">
                        {txnLoading && selectedPayout === p.id ? 'loading...' : 'View txns'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Raw JSON toggle */}
          <details className="mb-6">
            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600">
              View raw JSON (first payout)
            </summary>
            <pre className="mt-2 bg-gray-900 text-green-400 p-4 rounded text-xs overflow-auto max-h-80">
              {JSON.stringify(data.payouts[0], null, 2)}
            </pre>
          </details>
        </>
      )}

      {/* Payout transactions detail */}
      {txnData && !txnData.error && (
        <div className="border rounded p-4 bg-gray-50">
          <h2 className="font-bold mb-3">Payout #{txnData.payout_id} — Balance Transactions ({txnData.total})</h2>

          <div className="flex gap-6 mb-4 flex-wrap">
            <div>
              <div className="text-xs text-gray-500 mb-1">By transaction type:</div>
              {Object.entries(txnData.byType).map(([type, count]) => (
                <div key={type} className="text-xs"><span className="font-medium">{type}</span>: {count}</div>
              ))}
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">By source type:</div>
              {Object.entries(txnData.bySourceType).map(([type, count]) => (
                <div key={type} className="text-xs"><span className="font-medium">{type}</span>: {count}</div>
              ))}
            </div>
          </div>

          <div className="border rounded overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-100 border-b">
                <tr>
                  {['ID', 'Type', 'Source type', 'Amount', 'Fee', 'Net', 'Processed at', 'Source order ID'].map(h => (
                    <th key={h} className="text-left px-3 py-2 font-semibold text-gray-600">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {txnData.transactions.map((t: any) => (
                  <tr key={t.id} className="border-b hover:bg-white">
                    <td className="px-3 py-1.5 text-gray-400">{t.id}</td>
                    <td className="px-3 py-1.5">{t.type}</td>
                    <td className="px-3 py-1.5">{t.source_type}</td>
                    <td className={`px-3 py-1.5 font-medium ${parseFloat(t.amount) >= 0 ? 'text-green-700' : 'text-red-600'}`}>{t.amount}</td>
                    <td className="px-3 py-1.5 text-red-500">{t.fee}</td>
                    <td className={`px-3 py-1.5 font-semibold ${parseFloat(t.net) >= 0 ? 'text-green-700' : 'text-red-600'}`}>{t.net}</td>
                    <td className="px-3 py-1.5 text-gray-400">{new Date(t.processed_at).toLocaleString('vi-VN')}</td>
                    <td className="px-3 py-1.5 text-gray-400">{t.source_order_id ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600">
              View raw JSON (first transaction)
            </summary>
            <pre className="mt-2 bg-gray-900 text-green-400 p-4 rounded text-xs overflow-auto max-h-64">
              {JSON.stringify(txnData.transactions[0], null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  )
}
