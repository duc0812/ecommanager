'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'

type Row = { id: string; effectiveDate: string; rate: number }
function fmt(v: string) { return new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date(v)) }

export default function MetaRatesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState('')
  const [rate, setRate] = useState('')
  async function load() { setRows(await fetch('/api/meta/exchange-rates', { cache: 'no-store' }).then(r => r.json())) }
  useEffect(() => { load() }, [])
  async function add() {
    if (!date || !rate) return
    await fetch('/api/meta/exchange-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effectiveDate: date, rate: Number(rate) }) })
    setDate(''); setRate(''); load()
  }
  async function remove(id: string) {
    await fetch('/api/meta/exchange-rates', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    load()
  }
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Setup</p>
            <h2 className="text-display-md font-bold text-primary">Meta Exchange Rate</h2>
          </header>
          <section className="mb-xl rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg shadow-card">
            <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_1fr_auto]">
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <input value={rate} onChange={e => setRate(e.target.value)} inputMode="decimal" placeholder="VND per USD, e.g. 25500"
                className="rounded-lg border border-outline-variant/30 bg-surface-container px-md py-sm text-body-md outline-none focus:border-secondary" />
              <button onClick={add} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary">Add rate</button>
            </div>
            <p className="mt-xs text-body-sm text-on-surface-variant">Applies to non-USD (VND) accounts. A billing uses the rate effective on its date; dates before the earliest entry use the earliest rate.</p>
          </section>
          <ul className="space-y-sm">
            {rows.map(r => (
              <li key={r.id} className="flex items-center justify-between rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-md">
                <span className="text-label-md text-primary">{fmt(r.effectiveDate)} · <span className="text-on-surface-variant">{r.rate.toLocaleString('en-US')} VND/USD</span></span>
                <button onClick={() => remove(r.id)} className="text-error text-label-sm hover:underline">Remove</button>
              </li>
            ))}
            {rows.length === 0 && <p className="text-body-md text-on-surface-variant">No rates yet.</p>}
          </ul>
        </main>
      </div>
    </RoleGate>
  )
}
